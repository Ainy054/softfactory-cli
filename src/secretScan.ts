import fs from 'node:fs/promises';
import path from 'node:path';
import { findSecrets } from './redact.js';

const CONFIG_FILE = path.join('.softfactory', 'config.json');

/** `.env.*` variants that are meant to be committed and never hold real values. */
const ALLOWED_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

export interface AddedLine {
  path: string;
  lineNumber: number;
  content: string;
}

export interface SecretHit {
  path: string;
  lineNumber: number;
  kind: string;
}

/**
 * Reads the `secretScanAllow` override list from `.softfactory/config.json`.
 * Absent file or field means "no overrides"; an invalid regex is a
 * configuration bug and throws rather than silently matching nothing.
 */
export async function loadSecretScanAllow(baseDir: string): Promise<RegExp[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(baseDir, CONFIG_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`);
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const entries = (json as Record<string, unknown>).secretScanAllow;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new Error(`secretScanAllow in ${CONFIG_FILE} must be an array of regex strings`);
  }

  return entries.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`secretScanAllow[${index}] in ${CONFIG_FILE} must be a string`);
    }
    try {
      return new RegExp(entry);
    } catch {
      throw new Error(`Invalid regex in secretScanAllow[${index}] of ${CONFIG_FILE}: ${entry}`);
    }
  });
}

function normalizePath(filePath: string): string {
  let normalized = (filePath ?? '').replace(/\\/g, '/').trim();
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  return normalized;
}

function baseName(filePath: string): string {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

/** `.npmrc` / `.pypirc` are only secret files when they actually carry an auth token. */
function hasAuthToken(content: string): boolean {
  return /(?:authToken|_authToken|password|_password)\s*[=:]\s*\S+/i.test(String(content ?? ''));
}

/**
 * True when `path` names a file that must never carry committed credentials.
 *
 * `.npmrc` / `.pypirc` are configuration files that are often innocuous, so
 * they are only treated as secret files when the optional `content` shows an
 * auth token. Callers scanning a diff pass the file's added content.
 */
export function isSecretPath(filePath: string, content?: string): boolean {
  const base = baseName(filePath);
  if (base === '.env') return true;
  if (base.startsWith('.env.')) return !ALLOWED_ENV_EXAMPLES.has(base);
  if (base.endsWith('.pem')) return true;
  if (base.endsWith('.key')) return true;
  if (base.startsWith('id_rsa')) return true;
  if (base.endsWith('.p12')) return true;
  if (base === 'credentials.json') return true;
  if (base === '.npmrc' || base === '.pypirc') return content !== undefined && hasAuthToken(content);
  return false;
}

/**
 * Extracts only ADDED (`+`) lines from a unified diff, with their new-file line
 * numbers. `+++` headers, `---` headers, removed lines, hunk headers and the
 * `\ No newline at end of file` marker are all ignored.
 */
export function parseAddedLines(diff: string): AddedLine[] {
  const lines = String(diff ?? '').split('\n');
  const added: AddedLine[] = [];
  let filePath = '';
  let newLine = 0;
  let inHunk = false;

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git a/')) {
      const bIndex = line.indexOf(' b/');
      filePath = normalizePath(bIndex === -1 ? line.slice('diff --git a/'.length) : line.slice(bIndex + 3));
      inHunk = false;
      newLine = 0;
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (line.startsWith('+++ b/')) filePath = normalizePath(line.slice(6));
      inHunk = false;
      newLine = 0;
      continue;
    }

    if (line.startsWith('--- ')) {
      inHunk = false;
      newLine = 0;
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (!inHunk || !filePath) continue;

    if (line.startsWith('+')) {
      added.push({ path: filePath, lineNumber: newLine, content: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      // Removed lines do not advance the new-file line number.
    } else if (line.startsWith('\\')) {
      // `\ No newline at end of file` marker; it is not a file line.
    } else {
      newLine += 1;
    }
  }

  return added;
}

function matchesAny(patterns: RegExp[], value: string): boolean {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

/**
 * Paths that look like test fixtures: generic `key = value` matches are
 * suppressed there (fixtures often contain fake credentials), while
 * provider-prefixed tokens stay strict.
 */
function isTestFixturePath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return normalized.includes('test') || normalized.includes('__fixtures__') || normalized.includes('.fixture.');
}

/**
 * Scans a unified diff and returns only redacted facts about each hit: the
 * file path, new-file line number, and the credential kind. Secret-file paths
 * are rejected outright unless allowlisted; every added line is also scanned
 * with the credential patterns shared with `redactSecrets`.
 */
export async function scanDiff(diff: string, baseDir: string): Promise<SecretHit[]> {
  const allow = await loadSecretScanAllow(baseDir);
  const addedLines = parseAddedLines(diff);

  const byPath = new Map<string, AddedLine[]>();
  for (const added of addedLines) {
    const list = byPath.get(added.path);
    if (list) list.push(added);
    else byPath.set(added.path, [added]);
  }

  const hits: SecretHit[] = [];
  for (const [filePath, lines] of byPath) {
    const pathAllowed = matchesAny(allow, filePath);
    const combinedContent = lines.map((line) => line.content).join('\n');

    if (isSecretPath(filePath, combinedContent) && !pathAllowed) {
      hits.push({ path: filePath, lineNumber: lines[0].lineNumber, kind: 'Secret file path' });
      continue;
    }

    const fixture = isTestFixturePath(filePath);
    for (const added of lines) {
      const secrets = findSecrets(added.content, { allowedPatterns: allow });
      for (const secret of secrets) {
        if (fixture && secret.kind === 'Generic assignment') continue;
        hits.push({ path: filePath, lineNumber: added.lineNumber, kind: secret.kind });
      }
    }
  }

  return hits;
}
