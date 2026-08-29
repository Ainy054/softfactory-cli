export const MAX_WORKER_LOG_ENTRIES = 200;
export const MAX_WORKER_LINES_PER_CHUNK = 20;
export const MAX_WORKER_LINE_LENGTH = 240;

// Covers CSI color/control sequences commonly emitted by terminal-oriented CLIs.
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export function normalizeWorkerOutput(
  output: string,
  maxLength = MAX_WORKER_LINE_LENGTH,
  maxLines = MAX_WORKER_LINES_PER_CHUNK,
): string[] {
  const lines = output
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map(line => line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim())
    .filter(Boolean)
    .slice(-maxLines);

  return lines.map(line => line.length > maxLength
    ? `${line.slice(0, Math.max(0, maxLength - 1))}…`
    : line);
}

export function appendWorkerLog<T>(logs: T[], entry: T, maxEntries = MAX_WORKER_LOG_ENTRIES): T[] {
  return [...logs, entry].slice(-maxEntries);
}
