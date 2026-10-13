/**
 * What a finished run assumed but never checked (#86). The mongolbank-rates run
 * ended "completed" with metrics and nothing else, although it called a
 * website it never fetched, had no live check, and carried claims its workers
 * marked UNVERIFIED. This list is what a person reading the result needs
 * before trusting it, most serious first.
 */
import type { FactoryState } from './types.js';

export interface UnverifiedInput {
  state: Pick<FactoryState, 'external_sources' | 'verified' | 'uat_result'>;
  runNotes: Array<{ taskId: string; note: string }>;
  /** The merge target against the run's base: what this run actually shipped. */
  mergedDiff: string;
}

const MAX_LINES = 15;
const NOTE_PREFIXES = ['unverified claim:', 'unprobed fixture:', 'swallowed error:'];
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|testdata|test_data|fixtures|__fixtures__)\/|(?:\.test\.|\.spec\.|_test\.)|(?:^|\/)test_[^/]*\.py$/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
/** Files whose URLs are links, not calls: docs, licences, lock files. */
const NOT_CODE = /\.(?:md|mdx|rst|txt|adoc)$|(?:^|\/)(?:LICENSE|NOTICE|CHANGELOG)[^/]*$|(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)$/i;
/** A line that is only a comment: its URL is a reference, not a call. */
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|<!--)/;

/** One line per assumption the run never checked, most serious first, capped at 15. */
export function unverifiedAssumptions(input: UnverifiedInput): string[] {
  const lines: string[] = [];
  const probedHosts = new Set((input.state.external_sources ?? []).filter(source => source.ok).map(source => hostOf(source.url)).filter(Boolean));
  const seenUrls = new Set<string>();
  for (const url of shippedUrls(input.mergedDiff)) {
    const host = hostOf(url);
    if (!host || probedHosts.has(host) || seenUrls.has(url) || isLocal(host)) continue;
    seenUrls.add(url);
    lines.push(`calls ${url}, never fetched during planning`);
  }
  const uat = input.state.uat_result;
  if (input.state.verified === false || uat === 'none' || uat === 'skipped') lines.push(`no live check ran (uat: ${uat ?? 'none'})`);
  const seenNotes = new Set<string>();
  for (const { note } of input.runNotes) {
    const text = note.trim();
    if (!NOTE_PREFIXES.some(prefix => text.startsWith(prefix)) || seenNotes.has(text)) continue;
    seenNotes.add(text);
    lines.push(text);
  }
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more`];
}

/** http(s) URLs on added lines of files that are not tests or fixtures. */
function shippedUrls(diff: string): string[] {
  const urls: string[] = [];
  let file = '';
  for (const line of String(diff ?? '').split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { file = header[1].trim(); continue; }
    if (line.startsWith('diff --git ')) { file = ''; continue; }
    if (!file || TEST_PATH.test(file) || NOT_CODE.test(file) || !line.startsWith('+') || line.startsWith('+++')) continue;
    if (COMMENT_LINE.test(line.slice(1))) continue;
    for (const match of line.slice(1).matchAll(URL_PATTERN)) urls.push(match[0].replace(/[.,;:!?]+$/, ''));
  }
  return urls;
}

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/** A server the run starts itself is not an outside source. */
function isLocal(host: string): boolean {
  return /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/.test(host);
}
