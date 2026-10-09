import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `.softfactory/non-negotiables.txt`: the project rules no test catches
 * ("never log card numbers", "no `console.log` in src"). One rule per line,
 * `<regex> :: <reason>`. Blank lines and lines starting with `#` are ignored;
 * a line without ` :: ` uses the regex itself as the reason. An invalid regex
 * is a configuration bug, so it throws instead of silently matching nothing.
 */
export interface Rule {
  /** The regex source exactly as written in the file. */
  regex: string;
  /** Why the rule exists; defaults to the regex itself. */
  reason: string;
  /** The compiled matcher, used to scan added diff lines. */
  pattern: RegExp;
}

export interface RuleViolation {
  rule: string;
  reason: string;
  file: string;
  line: string;
}

export const RULES_FILE = path.join('.softfactory', 'non-negotiables.txt');

const SEPARATOR = ' :: ';

/** Reads `baseDir/.softfactory/non-negotiables.txt`, or `[]` when there is none. */
export async function loadRules(baseDir: string): Promise<Rule[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(baseDir, RULES_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const rules: Rule[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith('#')) continue;

    const separator = raw.indexOf(SEPARATOR);
    const regex = separator === -1 ? raw : raw.slice(0, separator).trim();
    const reason = separator === -1 ? raw : raw.slice(separator + SEPARATOR.length).trim();

    let pattern: RegExp;
    try {
      pattern = new RegExp(regex);
    } catch {
      throw new Error(`Invalid regex on line ${index + 1} of ${RULES_FILE}: ${regex}`);
    }
    rules.push({ regex, reason, pattern });
  }
  return rules;
}

/**
 * Scans only ADDED lines (`+` but not the `+++` header) and names the file from
 * the nearest `diff --git` header, so a removed line can never be a violation.
 */
export function violations(rules: Rule[], diff: string): RuleViolation[] {
  const found: RuleViolation[] = [];
  let file = '';
  for (const raw of diff.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      file = header[2];
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    const added = line.slice(1);
    for (const rule of rules) {
      if (rule.pattern.test(added)) {
        found.push({ rule: rule.regex, reason: rule.reason, file, line: added });
      }
    }
  }
  return found;
}
