import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

/**
 * Library code with no call site, borrowed from Softhouse's wiring census.
 * A task can pass every gate by adding a well-tested module that nothing
 * constructs: the tests call it, the acceptance command greps it, the
 * reviewer reads it, and no user can ever reach it. The census lists exported
 * functions and classes (Go: New* constructors) whose name appears nowhere
 * in non-test source except their own definition. Within one run the list may shrink but never
 * gain a name; the final gate enforces that.
 *
 * Known limitation, as in Softhouse: something called only from another
 * unwired export counts as wired. It is a ratchet, not a reachability proof.
 */
const DEFINITIONS: Array<{ ext: RegExp; def: RegExp }> = [
  { ext: /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/, def: /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm },
  { ext: /\.go$/, def: /^func\s+(New[A-Z]\w*)\s*\(/gm },
];
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|(?:^|\/)(?:__tests__|test|tests|e2e)\/)/;
const SKIP_DIR = /(?:^|\/)(?:node_modules|dist|build|vendor|\.softfactory)\//;

export interface UnwiredExport { name: string; file: string }

export async function wiringCensus(root: string, files?: string[]): Promise<UnwiredExport[]> {
  const tracked = files ?? (await execa('git', ['ls-files'], { cwd: root })).stdout.split('\n').filter(Boolean);
  const sources = tracked.filter(f => !SKIP_DIR.test(f) && DEFINITIONS.some(d => d.ext.test(f)));
  const contents = new Map<string, string>();
  for (const file of sources) {
    try { contents.set(file, await fs.readFile(path.join(root, file), 'utf8')); } catch { /* deleted in the working tree */ }
  }
  const callers = [...contents].filter(([file]) => !TEST_FILE.test(file));
  const unwired: UnwiredExport[] = [];
  for (const [file, text] of callers) {
    const rule = DEFINITIONS.find(d => d.ext.test(file))!;
    for (const match of text.matchAll(rule.def)) {
      const name = match[1];
      const reference = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      // Used inside its own file counts: an export kept for tests is still wired.
      const own = (text.match(reference) || []).length - 1;
      if (own <= 0 && !callers.some(([other, content]) => other !== file && new RegExp(reference.source).test(content))) unwired.push({ name, file });
    }
  }
  return unwired.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export const censusKey = (u: UnwiredExport) => `${u.file}#${u.name}`;

/** Names unwired now that were not in the baseline: the ratchet's failure set. */
export function newlyUnwired(baseline: string[], now: UnwiredExport[]): UnwiredExport[] {
  const before = new Set(baseline);
  // A file moved or renamed keeps its export's identity by name alone.
  const beforeNames = new Set(baseline.map(key => key.slice(key.lastIndexOf('#') + 1)));
  return now.filter(u => !before.has(censusKey(u)) && !beforeNames.has(u.name));
}
