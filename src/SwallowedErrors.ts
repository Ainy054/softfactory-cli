/**
 * Detects errors swallowed into empty results, using only a unified diff.
 *
 * The mongolbank-rates API wrapped every fetch in `except Exception: parsed = []`.
 * A live 404 page therefore became an empty list, served as HTTP 200 `[]`,
 * indistinguishable from "no data yet". Nothing in the merge gate looked for
 * failures that disappear into an empty success, so the inspector approved it
 * repeatedly.
 *
 * This scanner inspects the ADDED lines of a diff and reports catch-all handlers
 * whose body only discards the error. A handler that logs, re-raises or records
 * the error is fine. Narrow handlers (`except ValueError:`) are out of scope:
 * they are a deliberate statement about which failures to ignore.
 */

export interface SwallowedError {
  /** Path of the new file, taken from the `+++ b/` header. */
  file: string;
  /** 1-based line number of the `except` / `catch` clause in the new file. */
  line: number;
  /** The trimmed handler line that swallowed the error. */
  snippet: string;
}

interface AddedLine {
  path: string;
  line: number;
  content: string;
}

/** Directories and file names whose failures are the point of the file. */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//;
const TEST_NAME = /(?:\.test\.|\.spec\.)/;
const PY_TEST_FILE = /^test_.*\.py$/;

function normalizePath(filePath: string): string {
  let normalized = (filePath ?? '').replace(/\\/g, '/').trim();
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1).replace(/\\"/g, '"');
  }
  return normalized;
}

/** Test files are excluded: an assertion inside a test may legitimately swallow. */
export function isTestFilePath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  if (!normalized) return true;
  if (TEST_DIR.test(normalized)) return true;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return TEST_NAME.test(base) || PY_TEST_FILE.test(base);
}

/**
 * Extracts the added (`+`) lines of a unified diff with their new-file line
 * numbers, tracking the current file from the `+++ b/` header. Headers, removed
 * lines, hunk headers and the `\ No newline at end of file` marker are ignored.
 */
function parseAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let filePath = '';
  let newLine = 0;
  let inHunk = false;

  for (const raw of String(diff ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    // A `+++` header only appears between hunks; an added line whose content
    // begins with `++` is also `+++ ...` and must not be read as a header.
    if (!inHunk && line.startsWith('+++ ')) {
      filePath = normalizePath(line.slice(4).replace(/^b\//, '').split('\t')[0]);
      newLine = 0;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
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
      added.push({ path: filePath, line: newLine, content: line.slice(1) });
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

/** A line that logs, re-raises or otherwise records the error is not swallowing it. */
const RECORDS_ERROR = /(?:\blog(?:ger|ging)?\b|console\.(?:error|warn|log)|\bwarn(?:ing)?\b|\braise\b|\bthrow\b)/;

function stripComment(line: string): string {
  return line.replace(/\s*(?:#|\/\/).*$/, '');
}

function isPythonDiscard(line: string): boolean {
  const trimmed = stripComment(line).trim();
  if (!trimmed) return false;
  if (/^(?:pass|continue)\b/.test(trimmed)) return true;
  if (/^return\s*;?$/.test(trimmed)) return true;
  if (/^return\s+(?:None|\[\s*\]|\{\s*\}|""|''|0|False)\s*;?$/.test(trimmed)) return true;
  // An assignment to an empty collection / None: `parsed = []`, `data = {}`, `x = None`.
  if (/^[A-Za-z_$][\w$.]*\s*=\s*(?:\[\s*\]|\{\s*\}|None)\s*;?$/.test(trimmed)) return true;
  return false;
}

function isJsDiscard(statement: string): boolean {
  const trimmed = statement.trim();
  if (!trimmed) return false;
  if (/^return\s*;?$/.test(trimmed)) return true;
  if (/^return\s+(?:null|undefined|\[\s*\]|\{\s*\})\s*;?$/.test(trimmed)) return true;
  return false;
}

/**
 * Python catch-all clauses: `except:`, `except Exception:` and
 * `except Exception as e:`. Narrow clauses (`except ValueError:`) are ignored.
 * Returns the indentation and the inline remainder after the `:`.
 */
function matchPythonHandler(line: string): { indent: number; rest: string } | undefined {
  const match = /^(\s*)except(?:\s+Exception(?:\s+as\s+\w+)?)?\s*:(.*)$/.exec(line);
  if (!match) return undefined;
  return { indent: match[1].length, rest: match[2] };
}

/** `catch {`, `catch (e) {` and friends; returns the remainder after the `{`. */
function matchJsHandler(line: string): { rest: string } | undefined {
  const match = /(?:^|[^\w.$])catch\s*(?:\([^)]*\))?\s*\{(.*)$/.exec(line);
  if (!match) return undefined;
  return { rest: match[1] };
}

/** `.catch(() => {})`, `.catch(() => [])` and `.catch(() => null)` on one line. */
const ARROW_CATCH_DISCARD = /\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:\{\s*\}|\[\s*\]|null|undefined)\s*\)/;

/** Lines that are just the closing brace of a handler's block. */
function isStructural(line: string): boolean {
  return /^[)\]};]*$/.test(line.trim());
}

function pythonBodyDiscards(body: string[]): boolean {
  let sawDiscard = false;
  for (const raw of body) {
    const line = stripComment(raw).trim();
    if (!line || isStructural(line)) continue;
    if (!isPythonDiscard(line)) return false;
    sawDiscard = true;
  }
  return sawDiscard;
}

function jsBodyDiscards(body: string): boolean {
  const close = body.indexOf('}');
  const inner = close === -1 ? body : body.slice(0, close);
  const withoutComments = inner.replace(/\/\/.*$/gm, '');
  const statements = withoutComments.split(/[;\n\r]/).map(part => part.trim()).filter(Boolean);
  if (statements.length === 0) return true; // `catch {}` discards by doing nothing.
  return statements.every(isJsDiscard);
}

/**
 * Scans a unified diff for catch-all handlers that only discard the error.
 * Returns one hit per handler, in diff order, with the line number of the
 * `except` / `catch` clause in the new file.
 */
export function swallowedErrors(diff: string): SwallowedError[] {
  const added = parseAddedLines(diff);
  const hits: SwallowedError[] = [];

  for (let i = 0; i < added.length; i++) {
    const current = added[i];
    if (isTestFilePath(current.path)) continue;

    // The next added lines in the same file, capped at three.
    const following: AddedLine[] = [];
    for (let j = i + 1; j < added.length && following.length < 3; j++) {
      if (added[j].path !== current.path) break;
      following.push(added[j]);
    }

    if (ARROW_CATCH_DISCARD.test(current.content)) {
      hits.push({ file: current.path, line: current.line, snippet: current.content.trim() });
      continue;
    }

    const python = matchPythonHandler(current.content);
    if (python) {
      // The body is the inline remainder plus the indented lines that follow;
      // a line at or below the handler's indentation ends the block.
      const body: string[] = [python.rest];
      for (const line of following) {
        const text = line.content.endsWith('\r') ? line.content.slice(0, -1) : line.content;
        const indent = text.match(/^\s*/)?.[0].length ?? 0;
        if (text.trim() && indent <= python.indent) break;
        body.push(text);
      }
      if (body.some(line => RECORDS_ERROR.test(line))) continue;
      if (pythonBodyDiscards(body)) {
        hits.push({ file: current.path, line: current.line, snippet: current.content.trim() });
      }
      continue;
    }

    const js = matchJsHandler(current.content);
    if (js) {
      const body = [js.rest, ...following.map(line => line.content)].join('\n');
      if (RECORDS_ERROR.test(body)) continue;
      if (jsBodyDiscards(body)) {
        hits.push({ file: current.path, line: current.line, snippet: current.content.trim() });
      }
    }
  }

  return hits;
}
