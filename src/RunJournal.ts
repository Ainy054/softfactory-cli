import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { redactSecrets } from './redact.js';

/**
 * One append-only journal per run (feature), hash-chained: every entry
 * carries the hash of the entry before it and the hashes of any evidence
 * files it cites. `verify` recomputes the chain and re-hashes the files, so
 * a reviewer can check offline that the record of a run was not edited and
 * that the evidence on disk is the evidence the run saw.
 */
export interface JournalEntry {
  seq: number;
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
  /** Repository-relative path to sha256 of its content at the time of the entry. */
  files?: Record<string, string>;
  prev: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  filesChecked: number;
  problems: string[];
  head?: string;
}

export const GENESIS = '0'.repeat(64);

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** JSON with keys sorted at every level, so the same data always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).filter(key => (value as any)[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function entryHash(entry: Omit<JournalEntry, 'hash'>): string {
  const { seq, timestamp, event, data, files, prev } = entry;
  return sha256(`${prev}\n${canonical({ seq, timestamp, event, data, files })}`);
}

export class RunJournal {
  readonly path: string;
  private head: { seq: number; hash: string } | null = null;
  private loaded = false;
  private lock = Promise.resolve();

  constructor(private readonly baseDir: string, readonly runId: string) {
    this.path = RunJournal.pathFor(baseDir, runId);
  }

  static pathFor(baseDir: string, runId: string): string {
    return path.join(baseDir, '.softfactory', 'runs', runId, 'journal.jsonl');
  }

  /** Appends one entry; `files` are repository-relative paths whose current content is hashed in. */
  append(event: string, data: Record<string, unknown>, files: string[] = []): Promise<JournalEntry> {
    const run = this.lock.then(async () => {
      await this.loadHead();
      const hashed: Record<string, string> = {};
      for (const file of files) {
        try { hashed[file] = sha256(await fs.readFile(path.join(this.baseDir, file))); }
        catch { hashed[file] = 'missing'; }
      }
      const unsigned: Omit<JournalEntry, 'hash'> = {
        seq: (this.head?.seq ?? 0) + 1,
        timestamp: new Date().toISOString(),
        event,
        data: JSON.parse(redactSecrets(JSON.stringify(data))),
        files: Object.keys(hashed).length ? hashed : undefined,
        prev: this.head?.hash ?? GENESIS,
      };
      const entry: JournalEntry = { ...unsigned, hash: entryHash(unsigned) };
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      await fs.appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      this.head = { seq: entry.seq, hash: entry.hash };
      return entry;
    });
    // One failed append must not wedge the chain for the rest of the run.
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadHead(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const entries = await RunJournal.read(this.path);
    const last = entries[entries.length - 1];
    if (last) this.head = { seq: last.seq, hash: last.hash };
  }

  static async read(journalPath: string): Promise<JournalEntry[]> {
    try {
      const raw = await fs.readFile(journalPath, 'utf8');
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as JournalEntry);
    } catch {
      return [];
    }
  }

  /** Recomputes every hash in the chain and re-hashes every cited file. */
  static async verify(baseDir: string, runId: string): Promise<VerifyResult> {
    const problems: string[] = [];
    let entries: JournalEntry[];
    try {
      const raw = await fs.readFile(RunJournal.pathFor(baseDir, runId), 'utf8');
      entries = raw.split('\n').filter(Boolean).map((line, index) => {
        try { return JSON.parse(line) as JournalEntry; }
        catch { problems.push(`line ${index + 1}: not valid JSON`); return null as unknown as JournalEntry; }
      }).filter(Boolean);
    } catch {
      return { ok: false, entries: 0, filesChecked: 0, problems: [`no journal for run ${runId} at ${RunJournal.pathFor(baseDir, runId)}`] };
    }
    let prev = GENESIS;
    let filesChecked = 0;
    for (const [index, entry] of entries.entries()) {
      const expectedSeq = index + 1;
      if (entry.seq !== expectedSeq) problems.push(`entry ${index + 1}: seq is ${entry.seq}, expected ${expectedSeq} (an entry was removed or inserted)`);
      if (entry.prev !== prev) problems.push(`entry ${entry.seq} (${entry.event}): prev hash does not match the previous entry`);
      const { hash, ...unsigned } = entry;
      const recomputed = entryHash(unsigned);
      if (recomputed !== hash) problems.push(`entry ${entry.seq} (${entry.event}): content was changed after it was written`);
      for (const [file, recorded] of Object.entries(entry.files || {})) {
        filesChecked++;
        if (recorded === 'missing') continue;
        try {
          const actual = sha256(await fs.readFile(path.join(baseDir, file)));
          if (actual !== recorded) problems.push(`entry ${entry.seq} (${entry.event}): ${file} differs from the content recorded at the time`);
        } catch {
          problems.push(`entry ${entry.seq} (${entry.event}): cited file ${file} is missing`);
        }
      }
      prev = hash;
    }
    return { ok: problems.length === 0, entries: entries.length, filesChecked, problems, head: prev === GENESIS ? undefined : prev };
  }
}
