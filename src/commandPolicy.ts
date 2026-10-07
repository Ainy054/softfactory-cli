import path from 'node:path';
import { execa } from 'execa';
import { HostRunner, type CommandRunner } from './Sandbox.js';

/**
 * The one command policy for everything softfactory runs on a model's behalf:
 * worker run_command calls and a task's acceptance command alike. No shell,
 * an allowlist of executables, read-only pipelines only, every path argument
 * inside the worktree, and the obvious interpreter and git escapes closed.
 * This is a filter, not a boundary; the boundary is the sandbox runner.
 */

/** Where a command runs, so path arguments can be judged against it. */
export interface CommandScope { root: string; cwd: string }

const READ_ONLY = new Set(['ls', 'cat', 'grep', 'egrep', 'rg', 'find', 'head', 'tail', 'wc', 'pwd', 'file', 'stat']);
const ALLOWED = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'go', 'pytest', 'python', 'python3', 'cargo', 'git', 'tsc', 'eslint', 'vitest', 'make']);

export const ALLOWED_EXECUTABLES = [...ALLOWED].filter(name => name !== 'npx').concat([...READ_ONLY]);

export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY.has(command.trim().split(/\s+/, 1)[0]);
}

/** Splits on `|` outside quotes, so `rg 'foo|bar' src` stays one command. */
export function splitPipeline(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === '|') {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map(part => part.trim()).filter(Boolean);
}

/** Tokenizes one command and strips each quoted run down to its contents. */
export function parseCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map(part => part.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, s) => d ?? s));
}

export function assertAllowedCommandSegment(command: string, scope?: CommandScope): void {
  const executable = command.trim().split(/\s+/, 1)[0];
  if (!ALLOWED.has(executable) && !READ_ONLY.has(executable)) {
    throw new Error(`Command is not allowlisted: ${executable}`);
  }
  // find can execute: -exec ... + needs no shell metacharacter to fire.
  if (executable === 'find' && /(^|\s)-(?:exec|execdir|ok|okdir|delete|fls|fprint)\b/.test(command)) {
    throw new Error('find may only search, not execute or delete.');
  }
  // Scoped to interpreters. Applied to everything it also rejected `grep -c`,
  // `head -c` and `ls -p`, which are ordinary read-only flags.
  if (['node', 'python', 'python3'].includes(executable)
      && /(^|\s)-(?:e|c|p|-eval|-print|-command)\b/.test(command)) {
    throw new Error('Inline interpreter execution is not permitted.');
  }
  if (executable === 'git' && /(^|\s)-c\s|alias\.|!\s*\w|(^|\s)config(\s|$)/.test(command)) {
    throw new Error('git -c, git config and alias execution are not permitted.');
  }
  // Network and repository-mutating git is orchestrator work, never a worker's.
  if (executable === 'git' && /(^|\s)(?:push|fetch|pull|clone|remote|submodule|--git-dir(?:=|\s)|--work-tree(?:=|\s))\b/.test(command)) {
    throw new Error('git push/fetch/pull/clone/remote/submodule and --git-dir/--work-tree are not permitted.');
  }
  if (executable === 'npx') throw new Error('npx is not permitted because it can download and execute arbitrary packages.');
  if (/^(?:npm|pnpm|yarn)\s+(?:install|i|add|ci)\b/.test(command) && !/--ignore-scripts\b/.test(command)) {
    throw new Error('Package installation must pass --ignore-scripts.');
  }
  // Preload flags may name a package (`--import tsx`, `-r ts-node/register`):
  // that is how Node projects run TypeScript tests, including this one. A
  // file there (`-r ./evil.js`) is still refused; a path argument elsewhere is
  // already confined to the worktree below.
  if (executable === 'node') {
    for (const [, specifier] of command.matchAll(/(?:^|\s)(?:-r|--require|--import|--loader|--experimental-loader)(?:=|\s+)(\S*)/g)) {
      if (!/^(?:@[\w.-]+\/)?[\w-][\w.-]*(?:\/[\w.-]+)*$/.test(specifier) || specifier.startsWith('.')) {
        throw new Error('node preload flags may name an installed package, not a file.');
      }
    }
  }
  assertPathArgumentsInside(command, scope);
}

/**
 * Every path-shaped argument must resolve inside the worktree. Without this
 * `cat ~/.ssh/id_rsa`, `grep -r x /` and `git -C / log` were all allowlisted
 * commands: the executable was checked and its arguments were not.
 */
export function assertPathArgumentsInside(command: string, scope?: CommandScope): void {
  const [, ...args] = parseCommand(command);
  for (const token of args) {
    const candidates = token.includes('=') && token.startsWith('-') ? [token.slice(token.indexOf('=') + 1)] : [token];
    for (const value of candidates) {
      if (!value) continue;
      if (value.startsWith('~')) throw new Error(`Path argument escapes the worktree: ${value}`);
      const absolute = value.startsWith('/');
      const climbs = value.split(/[\\/]/).includes('..');
      if (!absolute && !climbs) continue;
      if (!scope) throw new Error(`Path argument escapes the worktree: ${value}`);
      const root = path.resolve(scope.root);
      const resolved = path.resolve(scope.cwd, value);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path argument escapes the worktree: ${value}`);
      }
    }
  }
}

export function assertAllowedCommand(command: unknown, scope?: CommandScope): asserts command is string {
  if (process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING === '1') {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid command.');
    return;
  }
  if (typeof command !== 'string' || command.length > 300) throw new Error('Invalid command.');
  if (/[;&`$<>\n\r]/.test(command) || /\|\|/.test(command)) throw new Error('Shell operators are not allowed.');
  const segments = splitPipeline(command);
  if (segments.length > 1 && segments.some(part => !isReadOnlyCommand(part))) throw new Error('Only read-only commands may be piped.');
  if (!segments.length) throw new Error('Invalid command.');
  for (const segment of segments) assertAllowedCommandSegment(segment, scope);
}

/** Non-null when the command would be refused; the message says why. */
export function commandPolicyViolation(command: unknown, scope?: CommandScope): string | null {
  try {
    assertAllowedCommand(command, scope);
    return null;
  } catch (error: any) {
    return error?.message || 'command refused';
  }
}

export function safeCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_KEY|APIKEY|AUTH|CREDENTIAL|ACCESS_KEY/i.test(key)) delete env[key];
  }
  return { ...env, CI: 'true' };
}

export interface SafeCommandResult { stdout: string; stderr: string; exitCode: number }

export interface RunSafeOptions {
  /** The worktree; path arguments must stay inside it. Defaults to cwd. */
  root?: string;
  /** Where the command executes: the sandbox container, or the host. */
  runner?: CommandRunner;
}

/**
 * Runs a (possibly piped) command under the policy, through the given
 * runner. Rejects with an execa-shaped error on a non-zero exit, as the
 * workers expect; the caller reads exitCode/stdout/stderr from it.
 */
export async function runSafeCommand(command: string, cwd: string, timeoutMs = 30000, options: RunSafeOptions = {}): Promise<SafeCommandResult> {
  const runner = options.runner || new HostRunner();
  const scope: CommandScope = { root: options.root || cwd, cwd };
  if (process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING === '1') {
    const shell = runner.kind === 'docker' ? 'sh' : '/bin/zsh';
    return runner.exec(shell, [runner.kind === 'docker' ? '-c' : '-lc', command], { cwd, timeout: timeoutMs, env: safeCommandEnv() });
  }
  const segments = splitPipeline(command);
  let input: string | undefined;
  let stderr = '';
  let exitCode = 0;
  for (const segment of segments) {
    assertAllowedCommandSegment(segment, scope);
    const [executable, ...commandArgs] = parseCommand(segment);
    const result = await runner.exec(executable, commandArgs, { cwd, timeout: timeoutMs, env: safeCommandEnv(), input });
    input = result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
  }
  return { stdout: input || '', stderr, exitCode };
}
