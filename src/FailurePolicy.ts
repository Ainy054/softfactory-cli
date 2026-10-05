import type { Task } from './types.js';

export type FailureClass = 'environment' | 'implementation' | 'scope';

const ENVIRONMENT_FAILURE = /(?:not reachable|unavailable|missing (?:dependency|model)|credentials?|api key|permission denied|port .*already|cannot connect|timed out|enoent|econnrefused|npm ci|install(?:ation)? failed)/i;
const SCOPE_SIGNAL = /(?:\b(?:task|request|change)\b[^.\n]{0,40}\btoo broad\b|\bdecompos\w*\b|\bscope\b[^.\n]{0,30}\b(?:too large|exceed|overwhelmed|out[- ]of[- ]scope)\b|\bout[- ]of[- ]scope\b|\bmultiple (?:features|areas)\b|\bcannot handle all\b)/i;

export function classifyFailure(feedback: string): FailureClass {
  if (ENVIRONMENT_FAILURE.test(feedback)) return 'environment';
  if (SCOPE_SIGNAL.test(feedback)) return 'scope';
  return 'implementation';
}

/**
 * Splitting is deliberately conservative: only a scope-shaped failure on a
 * task with multiple declared work areas and multiple verification obligations
 * qualifies. Environment and implementation failures must be repaired first.
 */
export function shouldRecommendSplit(task: Pick<Task, 'files_hint' | 'creates_files' | 'acceptance_criteria' | 'verification'>, feedback: string): boolean {
  const testFitFailure = /(?:no progress|no (?:successful|file) edits?|without a single successful edit|produced no file changes|placeholder|no test files|out[- ]of[- ]scope|repeated invalid edits|npm test failure|automated verification failed|multiple elements|does not (?:fulfill|satisfy)|missing .*coverage|only (?:makes|updated) .* rather than|without (?:fixing|implementing)|only contains .* changes)/i.test(feedback)
    && (task.acceptance_criteria?.length || 0) >= 4;
  if (classifyFailure(feedback) !== 'scope' && !testFitFailure) return false;
  const files = new Set([...(task.files_hint || []), ...(task.creates_files || [])]);
  return (files.size >= 2 || testFitFailure) && (task.acceptance_criteria?.length || 0) >= 2 && (task.verification?.length || 0) >= 1;
}
