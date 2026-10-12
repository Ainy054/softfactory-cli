import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FactoryState, Task } from './types.js';

export interface ExecResult { stdout: string; stderr: string; exitCode: number }
export type Exec = (file: string, args: string[], options?: { cwd?: string; input?: string; timeout?: number }) => Promise<ExecResult>;

const defaultExec: Exec = async (file, args, options = {}) => {
  const result = await execa(file, args, { cwd: options.cwd, input: options.input, timeout: options.timeout ?? 60_000, reject: false });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
};

export interface Issue { number: number; title: string; body: string; url: string }
export interface PullRequestRef { number: number; url: string; isDraft: boolean }

/**
 * The orchestrator's side of GitHub: reading an issue in, pushing the
 * integration branch and opening the pull request out. Workers never get
 * here; network git is forbidden to them by the command policy. Everything
 * goes through `gh`, so the user's own authentication is what is used.
 */
export class GitHub {
  constructor(private readonly baseDir: string, private readonly exec: Exec = defaultExec) {}

  /** True when gh is installed and logged in; the reason otherwise. */
  async availability(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const status = await this.exec('gh', ['auth', 'status'], { cwd: this.baseDir, timeout: 15_000 });
      if (status.exitCode === 0) return { ok: true };
      return { ok: false, reason: `gh is not logged in (${(status.stderr || status.stdout).trim().split('\n')[0] || 'gh auth status failed'})` };
    } catch (error: any) {
      return { ok: false, reason: `gh is not installed (${error?.message || 'spawn failed'})` };
    }
  }

  /** The repository's web URL, so the body can link blobs (mockups, evidence). */
  async repoUrl(): Promise<string> {
    const result = await this.exec('gh', ['repo', 'view', '--json', 'url', '-q', '.url'], { cwd: this.baseDir });
    if (result.exitCode !== 0) throw new Error(`Could not read the repository URL: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
  }

  async readIssue(number: number): Promise<Issue> {
    const result = await this.exec('gh', ['issue', 'view', String(number), '--json', 'number,title,body,url'], { cwd: this.baseDir });
    if (result.exitCode !== 0) throw new Error(`Could not read issue #${number}: ${(result.stderr || result.stdout).trim()}`);
    const data = JSON.parse(result.stdout);
    return { number: data.number, title: String(data.title || '').trim(), body: stripHtmlComments(String(data.body || '')).trim(), url: data.url };
  }

  async pushBranch(branch: string): Promise<void> {
    const result = await this.exec('git', ['push', '-u', 'origin', branch], { cwd: this.baseDir, timeout: 120_000 });
    if (result.exitCode !== 0) throw new Error(`git push of ${branch} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }

  async findOpenPullRequest(head: string): Promise<PullRequestRef | null> {
    const result = await this.exec('gh', ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url,isDraft', '--limit', '1'], { cwd: this.baseDir });
    if (result.exitCode !== 0) return null;
    try {
      const [first] = JSON.parse(result.stdout || '[]');
      return first ? { number: first.number, url: first.url, isDraft: Boolean(first.isDraft) } : null;
    } catch {
      return null;
    }
  }

  async createPullRequest(input: { base: string; head: string; title: string; body: string; draft: boolean }): Promise<PullRequestRef> {
    const args = ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body-file', '-', ...(input.draft ? ['--draft'] : [])];
    const result = await this.exec('gh', args, { cwd: this.baseDir, input: input.body });
    if (result.exitCode !== 0) throw new Error(`gh pr create failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
    const url = (result.stdout.match(/https:\/\/\S+\/pull\/\d+/) || [''])[0] || result.stdout.trim();
    const number = Number((url.match(/\/pull\/(\d+)/) || [])[1]) || 0;
    return { number, url, isDraft: input.draft };
  }

  async updatePullRequest(number: number, input: { title: string; body: string }): Promise<void> {
    const result = await this.exec('gh', ['pr', 'edit', String(number), '--title', input.title, '--body-file', '-'], { cwd: this.baseDir, input: input.body });
    if (result.exitCode !== 0) throw new Error(`gh pr edit failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }

  async markReady(number: number): Promise<void> {
    await this.exec('gh', ['pr', 'ready', String(number)], { cwd: this.baseDir });
  }

  /** The PR's state, for deciding whether a dependency is done (merged) or still waiting. */
  async prState(number: number): Promise<'OPEN' | 'MERGED' | 'CLOSED'> {
    const result = await this.exec('gh', ['pr', 'view', String(number), '--json', 'state', '-q', '.state'], { cwd: this.baseDir });
    if (result.exitCode !== 0) throw new Error(`Could not read PR #${number}: ${(result.stderr || result.stdout).trim()}`);
    const state = result.stdout.trim();
    if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') throw new Error(`Unexpected state for PR #${number}: ${state || '(empty)'}`);
    return state;
  }
}

/** Issue templates leave HTML comments behind; they are instructions to the author, not the requirement. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** The requirement a run works from, built from an issue and any extra words on the command line. */
export function requirementFromIssue(issue: Issue, extra = ''): string {
  const parts = [issue.title, issue.body, extra.trim() ? `Additional instructions from the operator:\n${extra.trim()}` : ''].filter(Boolean);
  return parts.join('\n\n');
}

export interface PullRequestBodyInput {
  state: FactoryState;
  baseDir: string;
  baseBranch: string;
  sandbox: string;
  journal?: { ok: boolean; entries: number; head?: string; problems: string[] };
  metrics?: { first_attempt_rate: number; rejected_by_category: Record<string, number>; tokens: { input: number; output: number } };
  /** Designer mockups changed on the integration branch, linked to their blob URLs. */
  mockups?: Array<{ file: string; url: string }>;
  generator: string;
}

/** The PR description: what was asked, what merged, how each task was checked, and where the record is. */
export async function buildPullRequestBody(input: PullRequestBodyInput): Promise<string> {
  const { state } = input;
  const agentTasks = state.tasks.filter(t => t.executor === 'agent');
  const done = state.tasks.filter(t => t.status === 'done');
  const lines: string[] = [];
  lines.push(`## ${state.feature}`, '');
  if (state.source?.kind === 'issue') lines.push(`Closes #${state.source.number} (${state.source.url})`, '');
  lines.push(`**Run status:** ${state.status}. ${done.length} of ${state.tasks.length} tasks merged into \`${state.integration_branch}\` on top of \`${input.baseBranch}\`.`, '');
  if (state.status !== 'completed') {
    const open = state.tasks.filter(t => t.status !== 'done');
    lines.push(`Unfinished: ${open.map(t => `${t.id} (${t.status}${t.executor !== 'agent' ? `, ${t.executor}` : ''})`).join(', ')}.`, '');
  }
  const results = new Map<string, string | undefined>();
  for (const task of state.tasks) if (task.evidence) results.set(task.id, await readResult(path.join(input.baseDir, task.evidence)));
  lines.push('### Tasks', '', '| Task | Title | Status | Attempts | Review | Acceptance |', '| :-- | :-- | :-- | --: | :-- | :-- |');
  for (const task of state.tasks) {
    lines.push(`| ${task.id} | ${escapeCell(task.title)} | ${task.status} | ${task.attempts} | ${reviewCell(task)} | ${acceptanceCell(task, results.get(task.id))} |`);
  }
  lines.push('');
  const evidenced = state.tasks.filter(t => t.evidence);
  if (evidenced.length) {
    lines.push('### Acceptance evidence', '');
    for (const task of evidenced) {
      const tail = await readTail(path.join(input.baseDir, task.evidence!), 20);
      lines.push(`<details><summary>${task.id}: <code>${escapeCell(task.verification_command || '')}</code></summary>`, '', '```', tail, '```', '</details>', '');
    }
  }
  if (input.mockups?.length) {
    lines.push('### Design mockups', '');
    for (const mockup of input.mockups) lines.push(`- [${mockup.file}](${mockup.url})`);
    lines.push('', `Run softfactory --design-review ${state.feature_id} to view them rendered.`, '');
  }
  lines.push('### Run record', '');
  lines.push(`- Strategy ${state.strategy}, cloud provider ${state.cloud_provider}, planner ${state.planner_provider}.`);
  lines.push(`- Sandbox: ${input.sandbox}.`);
  if (input.metrics) {
    const rejected = Object.entries(input.metrics.rejected_by_category).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none';
    lines.push(`- First-attempt pass rate ${input.metrics.first_attempt_rate} over ${agentTasks.length} agent task(s); rejections: ${rejected}; tokens ${input.metrics.tokens.input + input.metrics.tokens.output}.`);
  }
  if (input.journal) {
    lines.push(input.journal.ok
      ? `- Run journal: ${input.journal.entries} hash-chained entries, head \`${input.journal.head || ''}\`, verified. Re-check with \`softfactory --verify-run ${state.feature_id}\` in a checkout that has \`.softfactory/\`.`
      : `- Run journal: verification FAILED (${input.journal.problems.slice(0, 2).join('; ')}).`);
  }
  lines.push(`- Evidence logs and the journal live under \`.softfactory/\` in the machine that ran this; they are not committed.`, '');
  lines.push(`Generated by ${input.generator}.`);
  return lines.join('\n');
}

function reviewCell(task: Task): string {
  if (!task.inspection) return '';
  return task.inspection === 'mechanical-only' ? 'mechanical gates only' : `${task.inspection} (${task.inspector_model || ''})`;
}

/** The evidence log's verdict, so the table says what the log says. */
function acceptanceCell(task: Task, result?: string): string {
  if (!task.verification_command) return 'none declared';
  const command = `\`${escapeCell(task.verification_command)}\``;
  if (task.status !== 'done') return command;
  if (result === 'FAIL') return `${command} ${task.agent_role === 'test_writer' ? 'red, as expected before the implementation' : 'FAIL'}`;
  return `${command} ${result || 'PASS'}`;
}

async function readResult(file: string): Promise<string | undefined> {
  try { return (await fs.readFile(file, 'utf8')).match(/^RESULT: (PASS|FAIL)\s*$/m)?.[1]; }
  catch { return undefined; }
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function readTail(file: string, lines: number): Promise<string> {
  try {
    const content = await fs.readFile(file, 'utf8');
    return content.trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '(evidence file not found)';
  }
}
