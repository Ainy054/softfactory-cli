import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scout } from './Scout.js';
import { Factory } from './Factory.js';

/** Every temporary directory this file creates, removed once the suite ends. */
const tempDirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-scout-'));
  tempDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * The file that defines `exportCsv`, with the definition on line 3 so the
 * reported line number is unambiguous.
 */
const CSV_SOURCE = [
  "import fs from 'node:fs';",
  '',
  'export function exportCsv(rows: string[]): string {',
  "  return rows.join(',');",
  '}',
  '',
].join('\n');

/** A file that has nothing to do with the requirement. */
const UNRELATED_SOURCE = [
  'export function parseDate(input: string): Date {',
  '  return new Date(input);',
  '}',
  '',
].join('\n');

describe('scout: searching tracked files for the requirement', () => {
  it('finds the file that defines an identifier in backticks and reports its line', async () => {
    const baseDir = await makeDir();
    await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'src', 'csv.ts'), CSV_SOURCE);
    await fs.writeFile(path.join(baseDir, 'src', 'other.ts'), UNRELATED_SOURCE);

    const lines = await scout(baseDir, 'Add `exportCsv`', ['src/csv.ts', 'src/other.ts']);

    assert.equal(lines.length, 1, `expected only the defining file, got: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], '- src/csv.ts: mentions exportCsv (line 3: export function exportCsv(rows: string[]): string {)');
  });

  it('does not list unrelated files', async () => {
    const baseDir = await makeDir();
    await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'src', 'csv.ts'), CSV_SOURCE);
    await fs.writeFile(path.join(baseDir, 'src', 'other.ts'), UNRELATED_SOURCE);

    const lines = await scout(baseDir, 'Add `exportCsv`', ['src/csv.ts', 'src/other.ts']);

    assert.ok(lines.every(line => !line.includes('src/other.ts')), `unrelated file leaked in: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter(line => line.includes('src/csv.ts')).length, 1);
  });

  it('returns [] when nothing matches', async () => {
    const baseDir = await makeDir();
    await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'src', 'other.ts'), UNRELATED_SOURCE);

    const lines = await scout(baseDir, 'Add `exportCsv`', ['src/other.ts']);
    assert.deepEqual(lines, []);

    const noTerms = await scout(baseDir, '', ['src/other.ts']);
    assert.deepEqual(noTerms, []);
  });
});

interface CapturedPlan {
  featureHistory?: string;
}

/**
 * A Factory whose collaborators are all stubbed, so `plan()` runs the real
 * planning-input assembly without touching git, models or the filesystem
 * beyond the temporary base directory.
 */
async function harness(repositoryFiles: string[]): Promise<{ factory: any; baseDir: string; logs: string[]; capture: CapturedPlan }> {
  const baseDir = await makeDir();
  await fs.mkdir(path.join(baseDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(baseDir, 'src', 'csv.ts'), CSV_SOURCE);
  await fs.writeFile(path.join(baseDir, 'src', 'other.ts'), UNRELATED_SOURCE);

  const factory: any = new Factory(baseDir, '', { strategy: 'local' });
  const logs: string[] = [];
  const capture: CapturedPlan = {};
  factory.log = (line: string) => { logs.push(line); };
  factory.getRepositoryFiles = async () => repositoryFiles;
  factory.getRepoContext = async () => '';
  factory.getMemoryPatterns = async () => '';
  factory.getHistory = async () => [];
  factory.saveState = async () => {};
  factory.journalPlan = async () => {};
  factory.updateHistory = async () => {};
  factory.recurringFailureCategories = async () => [];
  // Keep the real planTasks -> planner.generateBlueprint path, but skip the
  // acceptance probing that would otherwise shell out.
  factory.prepareTasks = async () => [];
  factory.planner = {
    provider: 'local',
    generateBlueprint: async (input: { featureHistory?: string }) => {
      capture.featureHistory = input.featureHistory;
      return { feature: 'Test feature', tasks: [] };
    },
  };
  return { factory, baseDir, logs, capture };
}

describe('Factory: scout evidence in the planner input', () => {
  it('appends the "Already in the repository" section when scout returns hits', async () => {
    const { factory, logs, capture } = await harness(['src/csv.ts', 'src/other.ts']);

    await factory.plan('Add `exportCsv`');

    const input = capture.featureHistory ?? '';
    assert.match(input, /Already in the repository \(reuse or extend these; plan only the gap\):/);
    assert.match(input, /- src\/csv\.ts: mentions exportCsv \(line 3:/);
    assert.ok(logs.some(line => line === 'Scout: 1 file(s) already mention this requirement.'), `missing scout log: ${JSON.stringify(logs)}`);
  });

  it('does not append the section when scout returns no lines', async () => {
    const { factory, logs, capture } = await harness(['src/other.ts']);

    await factory.plan('Add `exportCsv`');

    const input = capture.featureHistory ?? '';
    assert.doesNotMatch(input, /Already in the repository/);
    assert.ok(!logs.some(line => line.startsWith('Scout:')), `unexpected scout log: ${JSON.stringify(logs)}`);
  });
});
