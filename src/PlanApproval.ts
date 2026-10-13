import readline from 'node:readline';
import type { FactoryState, Task } from './types.js';

/**
 * Plan approval, borrowed from Softhouse: an interactive run shows the plan
 * and waits for a yes before any worker starts. A plan is the cheapest place
 * to catch a wrong split, a missing file or the whole suite used as a gate;
 * every one of those cost a full run in the dogfood runs. CI and other
 * non-interactive runs, and runs with --yes, keep going unattended.
 */
export type PlanDecision = 'approve' | 'abort';
export type PlanApprover = (state: FactoryState) => Promise<PlanDecision>;

/** The plan as a table a person can check in one read. */
export function formatPlan(state: Pick<FactoryState, 'feature' | 'tasks'> & { token_estimate?: FactoryState['token_estimate']; external_sources?: FactoryState['external_sources'] }): string[] {
  const lines = [`Plan: ${state.feature} (${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'})`, ''];
  if (state.token_estimate) lines.splice(1, 0, `Planned budget: about ${state.token_estimate.tokens} tokens, from ${state.token_estimate.runs} past run(s)`);
  const sources = state.external_sources ?? [];
  if (sources.length) {
    lines.push(...sources.map(formatSource), '');
  }
  for (const task of state.tasks) lines.push(...formatTask(task), '');
  return lines;
}

/** One line per outside source the plan depends on, so a wrong address is visible before any task runs. */
function formatSource(source: NonNullable<FactoryState['external_sources']>[number]): string {
  return `source ${source.name} ${source.url} → ${source.status} ${source.contentType ?? ''} ${source.bytes ?? 0}B`;
}

function formatTask(task: Task): string[] {
  const deps = task.dependencies.length ? `after ${task.dependencies.join(', ')}` : 'no dependencies';
  const flags = [task.executor !== 'agent' ? task.executor : '', task.protected ? 'protected' : ''].filter(Boolean).join(', ');
  const files = [...new Set([...task.files_hint, ...task.creates_files.map(f => `${f} (new)`)])];
  return [
    `  ${task.id}  phase ${task.phase}  ${task.agent_role}${flags ? `  [${flags}]` : ''}  ${deps}`,
    `      ${task.title}`,
    `      files: ${files.join(', ') || '(none)'}`,
    `      done when: ${task.verification_command || task.verification[0] || '(no command)'}`,
  ];
}

/** Interactive when both ends are a terminal and --yes was not given. */
export function isInteractive(args: string[], stdin: { isTTY?: boolean } = process.stdin, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && !args.includes('--yes');
}

/** Asks on the terminal; anything but y or yes keeps the plan unstarted. */
export function terminalApprover(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): PlanApprover {
  return async state => {
    output.write(`\n${formatPlan(state).join('\n')}\n`);
    const rl = readline.createInterface({ input, output });
    try {
      const answer: string = await new Promise(resolve => rl.question('Start this plan? [y/N] ', resolve));
      return /^\s*y(es)?\s*$/i.test(answer) ? 'approve' : 'abort';
    } finally {
      rl.close();
    }
  };
}

/** Asks once on the terminal whether to run past the planned token budget. */
export function terminalBudgetConfirm(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): (message: string) => Promise<boolean> {
  return async message => {
    const rl = readline.createInterface({ input, output });
    try {
      const answer: string = await new Promise(resolve => rl.question(`\n${message}\nContinue past the planned budget? [y/N] `, resolve));
      return /^\s*y(es)?\s*$/i.test(answer);
    } finally {
      rl.close();
    }
  };
}
