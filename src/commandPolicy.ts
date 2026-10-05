import { execa } from 'execa';

/**
 * The one command policy for everything softfactory runs on a model's behalf:
 * worker run_command calls and a task's acceptance command alike. No shell,
 * an allowlist of executables, read-only pipelines only, and the obvious
 * interpreter and git escapes closed.
 */

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

export function assertAllowedCommandSegment(command: string): void {
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
  if (executable === 'npx') throw new Error('npx is not permitted because it can download and execute arbitrary packages.');
  if (/^(?:npm|pnpm|yarn)\s+(?:install|i|add|ci)\b/.test(command) && !/--ignore-scripts\b/.test(command)) {
    throw new Error('Package installation must pass --ignore-scripts.');
  }
}

export function assertAllowedCommand(command: unknown): asserts command is string {
  if (process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING === '1') {
    if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid command.');
    return;
  }
  if (typeof command !== 'string' || command.length > 300) throw new Error('Invalid command.');
  if (/[;&`$<>\n\r]/.test(command) || /\|\|/.test(command)) throw new Error('Shell operators are not allowed.');
  const segments = splitPipeline(command);
  if (segments.length > 1 && segments.some(part => !isReadOnlyCommand(part))) throw new Error('Only read-only commands may be piped.');
  if (!segments.length) throw new Error('Invalid command.');
  for (const segment of segments) assertAllowedCommandSegment(segment);
}

/** Non-null when the command would be refused; the message says why. */
export function commandPolicyViolation(command: unknown): string | null {
  try {
    assertAllowedCommand(command);
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

/**
 * Runs a (possibly piped) command under the policy. Rejects with execa's
 * error on a non-zero exit, as the workers expect; the caller reads
 * exitCode/stdout/stderr from it.
 */
export async function runSafeCommand(command: string, cwd: string, timeoutMs = 30000): Promise<SafeCommandResult> {
  if (process.env.SOFTFACTORY_DISABLE_TOOL_BLOCKING === '1') {
    const result = await execa('/bin/zsh', ['-lc', command], { cwd, timeout: timeoutMs, env: safeCommandEnv() });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  }
  const segments = splitPipeline(command);
  let input: string | undefined;
  let stderr = '';
  let exitCode = 0;
  for (const segment of segments) {
    assertAllowedCommandSegment(segment);
    const [executable, ...commandArgs] = parseCommand(segment);
    const result = await execa(executable, commandArgs, { cwd, timeout: timeoutMs, env: safeCommandEnv(), input });
    input = result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode ?? 0;
  }
  return { stdout: input || '', stderr, exitCode };
}
