import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeText } from './Backlog.js';

/**
 * The gate register, borrowed from Softhouse: `.softfactory/gates.md`, a
 * markdown table people edit by hand. Gates of an always-stop class (the
 * program's `policy.always_stop`) wait for a person; any other class the
 * driver decides and writes down with its reason, and a question already
 * decided is cited instead of asked again.
 */
export const GATES_FILE = path.join('.softfactory', 'gates.md');

export interface Gate {
  id: string;
  class: string;
  status: string;
  /** Path globs, from the comma-separated scope cell. */
  scope: string[];
  question: string;
  chosen_by: string;
  date: string;
}

const COLUMNS = ['id', 'class', 'status', 'scope', 'question', 'chosen by', 'date'];
const HEADER = `| ${COLUMNS.join(' | ')} |\n| ${COLUMNS.map(() => '---').join(' | ')} |\n`;

function gatesPath(baseDir: string): string {
  return path.join(baseDir, GATES_FILE);
}

/** Splits a table row on unescaped pipes; leading and trailing pipes are optional. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function escapeCell(text: string): string {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Every gate row in file order. Rows that cannot be read (too few cells, no id,
 * class or status) are skipped and reported with their line number; missing
 * trailing cells are empty.
 */
export async function readGates(baseDir: string): Promise<{ gates: Gate[]; skipped: string[] }> {
  let content: string;
  try { content = await fs.readFile(gatesPath(baseDir), 'utf8'); }
  catch { return { gates: [], skipped: [] }; }
  const gates: Gate[] = [];
  const skipped: string[] = [];
  content.split('\n').forEach((line, index) => {
    if (!line.trim().startsWith('|')) return;
    const row = cells(line);
    if (row.every(cell => /^:?-{3,}:?$/.test(cell))) return;
    if (row[0]?.toLowerCase() === 'id' && row[1]?.toLowerCase() === 'class') return;
    const [id = '', klass = '', status = '', scope = '', question = '', chosenBy = '', date = ''] = row;
    if (row.length < 3 || !id || !klass || !status) {
      skipped.push(`line ${index + 1}: ${line.trim().slice(0, 120)}`);
      return;
    }
    gates.push({
      id, class: klass.toLowerCase(), status: status.toLowerCase(),
      scope: scope.split(',').map(s => s.trim()).filter(Boolean),
      question, chosen_by: chosenBy, date,
    });
  });
  return { gates, skipped };
}

/** Open gates whose class always waits for a person. */
export async function openGates(baseDir: string, alwaysStop: string[]): Promise<Gate[]> {
  const classes = new Set(alwaysStop.map(c => c.toLowerCase()));
  return (await readGates(baseDir)).gates.filter(gate => gate.status === 'open' && classes.has(gate.class));
}

/** A decided gate asking the same question (case, spacing and punctuation blind), if any. */
export async function answered(baseDir: string, question: string): Promise<Gate | undefined> {
  const wanted = normalizeText(question);
  if (!wanted) return undefined;
  return (await readGates(baseDir)).gates.find(gate => gate.status === 'decided' && normalizeText(gate.question) === wanted);
}

export type GateDecision =
  | { stop: false; gate: Gate; cited: boolean }
  | { stop: true; gate: Gate };

/**
 * Records a decision the driver met. A question already decided is cited and
 * nothing is written. An always-stop class appends an `open` row and returns
 * `stop: true`; any other class appends a `decided` row with
 * `driver: <choice>, <reason>` and today's date.
 */
export async function decideGate(baseDir: string, input: { class: string; scope: string; question: string; choice: string; reason: string }, alwaysStop: string[]): Promise<GateDecision> {
  const klass = input.class.trim().toLowerCase();
  const stops = alwaysStop.map(c => c.toLowerCase()).includes(klass);
  if (!stops) {
    const prior = await answered(baseDir, input.question);
    if (prior) return { stop: false, gate: prior, cited: true };
  }
  const { gates } = await readGates(baseDir);
  const next = 1 + gates.reduce((max, gate) => Math.max(max, Number(/^G(\d+)$/i.exec(gate.id)?.[1] ?? 0)), 0);
  const gate: Gate = {
    id: `G${next}`,
    class: klass,
    status: stops ? 'open' : 'decided',
    scope: input.scope.split(',').map(s => s.trim()).filter(Boolean),
    question: input.question.trim(),
    chosen_by: stops ? '' : `driver: ${input.choice.trim()}, ${input.reason.trim()}`,
    date: stops ? '' : new Date().toISOString().slice(0, 10),
  };
  const file = gatesPath(baseDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let content = '';
  try { content = await fs.readFile(file, 'utf8'); } catch { /* first gate */ }
  if (!content.trim()) content = `# Gates\n\n${HEADER}`;
  else if (!content.endsWith('\n')) content += '\n';
  const row = [gate.id, gate.class, gate.status, gate.scope.join(', '), gate.question, gate.chosen_by, gate.date].map(escapeCell);
  await fs.writeFile(file, `${content}| ${row.join(' | ')} |\n`, 'utf8');
  return stops ? { stop: true, gate } : { stop: false, gate, cited: false };
}
