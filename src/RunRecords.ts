import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './redact.js';

/**
 * Committed run records, borrowed from Softhouse. A run's evidence lives in
 * the git-ignored .softfactory/ directory, so a reviewer of the pull request
 * cannot see why a task passed. With `commitRecords: true` in
 * .softfactory/config.json, the run's evidence, journal, saved prompts,
 * handoff rows and metrics are committed under softfactory-records/<run>/
 * with the final merge. Opt-in per project (decided 2026-10-09): prompts are
 * tens of KB per attempt and nothing lands in history unasked.
 */
export const RECORDS_DIR = 'softfactory-records';
const MAX_FILE_BYTES = 1_000_000;

export async function commitRecordsEnabled(baseDir: string): Promise<boolean> {
  try {
    const config = JSON.parse(await fs.readFile(path.join(baseDir, '.softfactory', 'config.json'), 'utf8'));
    return config?.commitRecords === true;
  } catch {
    return false;
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry => {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return [];
      return entry.isDirectory() ? filesUnder(full) : [full];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

async function writeRedacted(target: string, text: string): Promise<void> {
  const clipped = text.length > MAX_FILE_BYTES ? `${text.slice(0, MAX_FILE_BYTES)}\n[truncated at ${MAX_FILE_BYTES} bytes]\n` : text;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, redactSecrets(clipped), 'utf8');
}

/** Writes the run's records, secrets redacted; returns the paths written, relative to baseDir. */
export async function writeRunRecords(baseDir: string, featureId: string, metrics?: unknown): Promise<string[]> {
  const state = path.join(baseDir, '.softfactory');
  const out = path.join(baseDir, RECORDS_DIR, featureId);
  const written: string[] = [];
  const copy = async (from: string, to: string) => {
    const text = await fs.readFile(from, 'utf8').catch(() => null);
    if (text === null) return;
    await writeRedacted(to, text);
    written.push(path.relative(baseDir, to));
  };
  for (const file of await filesUnder(path.join(state, 'evidence', featureId))) {
    await copy(file, path.join(out, 'evidence', path.relative(path.join(state, 'evidence', featureId), file)));
  }
  for (const file of await filesUnder(path.join(state, 'runs', featureId))) {
    await copy(file, path.join(out, path.relative(path.join(state, 'runs', featureId), file)));
  }
  const index = await fs.readFile(path.join(state, 'handoff-index.tsv'), 'utf8').catch(() => '');
  const [header, ...rows] = index.split('\n');
  const ours = rows.filter(row => row.split('\t')[1] === featureId);
  if (ours.length) {
    await writeRedacted(path.join(out, 'handoffs.tsv'), `${header}\n${ours.join('\n')}\n`);
    written.push(path.relative(baseDir, path.join(out, 'handoffs.tsv')));
  }
  if (metrics) {
    await writeRedacted(path.join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
    written.push(path.relative(baseDir, path.join(out, 'metrics.json')));
  }
  return written.sort();
}
