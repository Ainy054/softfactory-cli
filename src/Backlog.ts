import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Follow-ups a worker noticed outside its own task, carried forward in
 * `.softfactory/backlog.jsonl`. The notice would otherwise be lost, so it is
 * kept here until the next plan reads the open entries and a person keeps,
 * drops or promotes each one. Nothing is deleted: triage only rewrites status.
 */
export interface Entry {
  id: string;
  text: string;
  task_id: string;
  feature_id: string;
  status: 'open' | 'kept' | 'dropped' | 'promoted';
  created_at: string;
}

export type Decision = 'keep' | 'drop' | 'promote';

export const BACKLOG_FILE = path.join('.softfactory', 'backlog.jsonl');
/** A single task may leave at most this many un-triaged follow-ups behind. */
export const MAX_ITEMS_PER_TASK = 5;
/** Anything longer is a task, not a notice; keep each item to one line. */
export const MAX_ITEM_LENGTH = 240;

/** Case, whitespace and punctuation blind, so "Fix the X." and "fix the x" are one item. */
export function normalizeText(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function backlogPath(baseDir: string): string {
  return path.join(baseDir, BACKLOG_FILE);
}

/** Every entry, in file order. A torn line from a concurrent writer is skipped, never fatal. */
async function readEntries(baseDir: string): Promise<Entry[]> {
  let content: string;
  try { content = await fs.readFile(backlogPath(baseDir), 'utf8'); }
  catch { return []; }
  const entries: Entry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Entry;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.text === 'string' && typeof parsed.status === 'string') entries.push(parsed);
    } catch { /* a half-written line is skipped */ }
  }
  return entries;
}

/** Rewrites the whole file through a uniquely named temp, so a reader never sees a partial one. */
async function writeEntries(baseDir: string, entries: Entry[]): Promise<void> {
  const file = backlogPath(baseDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Records the gaps a task noticed outside its scope. Items are trimmed to one
 * line of at most 240 characters, de-duplicated by normalized text against the
 * open and kept entries already on file, and a task may own at most five of
 * them at once. Returns the entries actually written.
 */
export async function appendFollowUps(baseDir: string, featureId: string, taskId: string, items: string[]): Promise<Entry[]> {
  const cleaned = (items ?? [])
    .map(item => String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_LENGTH))
    .filter(Boolean);
  if (!cleaned.length) return [];

  const entries = await readEntries(baseDir);
  const live = entries.filter(e => e.status === 'open' || e.status === 'kept');
  const seen = new Set(live.map(e => normalizeText(e.text)));
  let capacity = Math.max(0, MAX_ITEMS_PER_TASK - live.filter(e => e.task_id === taskId).length);

  const added: Entry[] = [];
  for (const text of cleaned) {
    if (capacity <= 0) break;
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry: Entry = {
      id: `bl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      text,
      task_id: taskId,
      feature_id: featureId,
      status: 'open',
      created_at: new Date().toISOString(),
    };
    entries.push(entry);
    added.push(entry);
    capacity--;
  }

  if (added.length) {
    const file = backlogPath(baseDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, added.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  return added;
}

/** The entries a plan should still consider: open and kept, in the order they were recorded. */
export async function openBacklog(baseDir: string): Promise<Entry[]> {
  return (await readEntries(baseDir)).filter(e => e.status === 'open' || e.status === 'kept');
}

/**
 * Rewrites one entry's status. `promote` also returns the text so the caller
 * can queue it the way `--queue` does; `keep` and `drop` return undefined.
 * An unknown id is a no-op, so a stale list cannot crash a run.
 */
export async function triage(baseDir: string, id: string, decision: Decision): Promise<string | undefined> {
  const status: Entry['status'] = decision === 'keep' ? 'kept' : decision === 'drop' ? 'dropped' : 'promoted';
  const entries = await readEntries(baseDir);
  const entry = entries.find(e => e.id === id);
  if (!entry) return undefined;
  entry.status = status;
  await writeEntries(baseDir, entries);
  return decision === 'promote' ? entry.text : undefined;
}
