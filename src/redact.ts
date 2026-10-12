/**
 * Credential shapes that must never reach a lesson, a training record or a
 * journal. Each pattern names a real leak class the earlier single regex
 * missed: provider token prefixes, env-style assignments, URL credentials,
 * JSON-quoted keys and PEM blocks.
 */
export const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,                       // OpenAI / Stripe style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,                           // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                          // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                        // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,                              // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /(\w+:\/\/[^\s/:@]+:)[^\s/@]+(@)/g,                         // URL credentials
  /("(?:[A-Za-z0-9_-]*(?:api[_-]?key|apikey|authorization|password|passwd|secret|token|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)"\s*:\s*")[^"]*(")/gi, // JSON keys
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)["']?[^\s"',;]+["']?/g, // env-style
  /(?:api[_ -]?key|authorization|bearer|password|passwd|secret|token)\s*[:=]\s*(?:Bearer\s+)?[^\s,;"'`}]+/gi,
];

export function redactSecrets(value: string): string {
  let text = String(value ?? '');
  text = text.replace(PATTERNS[0], '[REDACTED_PRIVATE_KEY]');
  for (const pattern of PATTERNS.slice(1, 9)) text = text.replace(pattern, '[REDACTED_SECRET]');
  text = text.replace(PATTERNS[9], '$1[REDACTED_SECRET]$2');
  text = text.replace(PATTERNS[10], '$1[REDACTED_SECRET]$2');
  text = text.replace(PATTERNS[11], '$1[REDACTED_SECRET]');
  text = text.replace(PATTERNS[12], '[REDACTED_SECRET]');
  return text;
}

interface SecretPattern {
  pattern: RegExp;
  kind: string;
  /**
   * Name-based patterns (`password = ...`, `"token": "..."`) match code that
   * merely handles a credential: `token: string`, `api_key =
   * os.environ["API_KEY"]`. They count only when the value is a hard-coded
   * literal that is not a placeholder. Provider-prefixed patterns stay strict
   * so a fixture-looking token still fails the gate.
   */
  placeholderFilter?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { pattern: PATTERNS[0], kind: 'PEM private key' },
  { pattern: PATTERNS[1], kind: 'OpenAI/Stripe key' },
  { pattern: PATTERNS[2], kind: 'Anthropic key' },
  { pattern: PATTERNS[3], kind: 'GitHub token' },
  { pattern: PATTERNS[4], kind: 'GitHub token' },
  { pattern: PATTERNS[5], kind: 'Slack token' },
  { pattern: PATTERNS[6], kind: 'AWS access key' },
  { pattern: PATTERNS[7], kind: 'Google API key' },
  { pattern: PATTERNS[8], kind: 'JWT' },
  { pattern: PATTERNS[9], kind: 'URL credential' },
  { pattern: PATTERNS[10], kind: 'JSON key assignment', placeholderFilter: true },
  { pattern: PATTERNS[11], kind: 'Generic assignment', placeholderFilter: true },
  { pattern: PATTERNS[12], kind: 'Generic assignment', placeholderFilter: true },
  // PATTERNS[12] stops at a quote, so a quoted literal assigned to a password
  // or token name in code never matched it; the gate needs the quoted form too.
  { pattern: /\b\w*(?:api[_-]?key|apikey|password|passwd|secret|secret[_-]?key|token|private[_-]?key|access[_-]?key)\s*[:=]\s*["'`][^"'`\n]+["'`]/gi, kind: 'Generic assignment', placeholderFilter: true },
];

const PLACEHOLDER_VALUES = new Set(['xxx', 'your-api-key', 'changeme', 'example']);

/**
 * Placeholder detection inspects only the value side of an assignment (not the
 * key), so a real key named `EXAMPLE_API_KEY` never hides a real token behind
 * the word "example".
 */
function isPlaceholderValue(raw: string): boolean {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/_/g, '-');
  if (PLACEHOLDER_VALUES.has(normalized)) return true;
  if (/^<[^>]+>$/.test(value)) return true;
  if (value.length > 0 && [...value].every((ch) => ch === value[0])) return true;
  return false;
}

/**
 * The hard-coded value an assignment holds, or undefined when it holds an
 * expression. `rest` is the line from the match onward. A quoted literal
 * counts anywhere; a bare value (`TOKEN=abc123`) only where bare values are
 * literals (env, shell, YAML, INI files), since in code it is an identifier
 * or a type (`token: string`).
 */
function literalValue(rest: string, bareValues: boolean): string | undefined {
  const at = rest.search(/[=:]/);
  if (at === -1) return undefined;
  const value = rest.slice(at + 1).trim().replace(/^Bearer\s+/i, '');
  const quoted = /^(['"`])([^'"`]*)\1/.exec(value);
  if (quoted) return quoted[2].includes('${') ? undefined : quoted[2];
  if (!bareValues) return undefined;
  const bare = /^[^\s,;'"`]+/.exec(value)?.[0];
  if (!bare || /[()[\]{}$]/.test(bare) || /^(?:process\.env|os\.environ|env\.|getenv)/i.test(bare)) return undefined;
  return bare;
}

/** A literal that could be a real credential: long enough, one token, not a placeholder. */
function couldBeCredential(value: string): boolean {
  return value.length >= 8 && !/\s/.test(value) && !isPlaceholderValue(value);
}

/** Returns the full line (without the trailing `\n`) that contains `index`. */
function lineForIndex(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).replace(/\r$/, '');
}

/**
 * Scans a string with the credential patterns shared with `redactSecrets`.
 *
 * `allowedPatterns` skips any line that matches one of the allow regexes
 * (matched case-insensitively and anchored to the line that holds the hit, so
 * an allow entry can never leak across line boundaries).
 */
export function findSecrets(
  text: string,
  options: { allowedPatterns?: RegExp[]; bareValues?: boolean } = {},
): Array<{ kind: string; match: string }> {
  const input = String(text ?? '');
  const allowedPatterns = (options.allowedPatterns ?? []).map((raw) => {
    const flags = raw.flags.includes('i') ? raw.flags : `${raw.flags}i`;
    return new RegExp(raw.source, flags);
  });

  const isAllowed = (line: string): boolean => {
    for (const pattern of allowedPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) return true;
    }
    return false;
  };

  const hits: Array<{ kind: string; match: string }> = [];
  for (const { pattern, kind, placeholderFilter } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const matched = match[0];
      const line = lineForIndex(input, match.index);
      if (allowedPatterns.length > 0 && isAllowed(line)) {
        if (matched.length === 0) pattern.lastIndex++;
        continue;
      }
      const lineStart = input.lastIndexOf('\n', match.index - 1) + 1;
      const rest = line.slice(match.index - lineStart);
      const literal = placeholderFilter ? literalValue(rest, options.bareValues ?? true) : undefined;
      if (placeholderFilter && (literal === undefined || !couldBeCredential(literal))) {
        if (matched.length === 0) pattern.lastIndex++;
        continue;
      }
      hits.push({ kind, match: matched });
      if (matched.length === 0) pattern.lastIndex++;
    }
  }
  return hits;
}
