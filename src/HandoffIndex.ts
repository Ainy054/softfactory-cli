import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './redact.js';

/**
 * One row per merged task, borrowed from Softhouse's handoff-index.tsv: the
 * planner's grep-able memory of how similar work was cut before. Lessons say
 * what went wrong; this says what was done, in which files, and how it was
 * checked, so a new plan can reuse a split that already worked.
 */
export interface HandoffRow {
  date: string;
  feature_id: string;
  task_id: string;
  title: string;
  files: string[];
  acceptance: string;
  summary: string;
}

export const HANDOFF_INDEX = path.join('.softfactory', 'handoff-index.tsv');
const HEADER = ['date', 'feature_id', 'task_id', 'title', 'files', 'acceptance', 'summary'].join('\t');

const cell = (text: string, max: number) => redactSecrets(String(text ?? '')).replace(/[\t\r\n]+/g, ' ').trim().slice(0, max);

export async function appendHandoff(baseDir: string, row: HandoffRow): Promise<void> {
  const file = path.join(baseDir, HANDOFF_INDEX);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const exists = await fs.access(file).then(() => true, () => false);
  const line = [cell(row.date, 10), cell(row.feature_id, 40), cell(row.task_id, 40), cell(row.title, 160), cell(row.files.join(','), 300), cell(row.acceptance, 200), cell(row.summary, 300)].join('\t');
  await fs.appendFile(file, `${exists ? '' : `${HEADER}\n`}${line}\n`, 'utf8');
}

export async function readHandoffs(baseDir: string): Promise<HandoffRow[]> {
  let content: string;
  try { content = await fs.readFile(path.join(baseDir, HANDOFF_INDEX), 'utf8'); }
  catch { return []; }
  return content.split('\n').slice(1).filter(Boolean).map(line => {
    const [date, feature_id, task_id, title, files, acceptance, summary] = line.split('\t');
    return { date, feature_id, task_id, title, files: (files || '').split(',').filter(Boolean), acceptance: acceptance || '', summary: summary || '' };
  });
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'each', 'must', 'only', 'should', 'add', 'make', 'use', 'not', 'are', 'its', 'then', 'than', 'have', 'has']);
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []).filter(w => !STOP.has(w)));

/** The rows most like the requirement, as lines for the planning prompt; empty when none share a meaningful word. */
export async function similarHandoffs(baseDir: string, requirement: string, limit = 8): Promise<string[]> {
  const wanted = words(requirement);
  if (!wanted.size) return [];
  const scored = (await readHandoffs(baseDir)).map(row => {
    const haystack = words(`${row.title} ${row.files.join(' ')} ${row.summary}`);
    let score = 0;
    for (const w of wanted) if (haystack.has(w)) score++;
    // A path named in the requirement is the strongest signal there is.
    for (const file of row.files) if (requirement.includes(file)) score += 5;
    return { row, score };
  }).filter(x => x.score >= 2).sort((a, b) => b.score - a.score || b.row.date.localeCompare(a.row.date)).slice(0, limit);
  return scored.map(({ row }) => `- ${row.date} ${row.task_id} "${row.title}" — files: ${row.files.join(', ') || '(none)'}; checked by: ${row.acceptance || '(none)'}; ${row.summary}`);
}
