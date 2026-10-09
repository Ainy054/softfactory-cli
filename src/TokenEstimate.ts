import type { RunMetrics } from './Metrics.js';

/**
 * A planned token budget, borrowed from Softhouse. --max-tokens is a cap the
 * user has to guess; this one is estimated from the project's own history:
 * the median tokens per finished task over the last runs, times the plan's
 * agent tasks, with room for retries. Past 80% of it the run stops and asks.
 */
export const ESTIMATE_RUNS = 5;
export const RETRY_ALLOWANCE = 1.5;
export const ASK_AT = 0.8;

/** Tokens one finished task cost in a past run, or undefined when the run tells nothing. */
export function tokensPerTask(run: Partial<RunMetrics> & { tokens_per_done_task?: number }): number | undefined {
  if (typeof run.tokens_per_done_task === 'number' && run.tokens_per_done_task > 0) return run.tokens_per_done_task;
  const total = (run.tokens?.input || 0) + (run.tokens?.output || 0);
  const done = (run.done || 0) - (run.manual || 0);
  return total > 0 && done > 0 ? total / done : undefined;
}

export interface TokenEstimate { tokens: number; runs: number }

/** Undefined without history: no estimate means no check. */
export function estimateTokens(recent: RunMetrics[], agentTasks: number): TokenEstimate | undefined {
  const samples = recent.slice(-ESTIMATE_RUNS).map(tokensPerTask).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
  if (!samples.length || agentTasks <= 0) return undefined;
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  return { tokens: Math.round(median * agentTasks * RETRY_ALLOWANCE), runs: samples.length };
}

/** The message when use has reached the ask threshold, or null below it. */
export function overEstimate(used: number, estimate: TokenEstimate): string | null {
  if (used < estimate.tokens * ASK_AT) return null;
  return `Token use passed ${Math.round(ASK_AT * 100)}% of the planned budget: ${used} of about ${estimate.tokens} tokens, estimated from ${estimate.runs} past run(s).`;
}
