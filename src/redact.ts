/**
 * Credential shapes that must never reach a lesson, a training record or a
 * journal. Each pattern names a real leak class the earlier single regex
 * missed: provider token prefixes, env-style assignments, URL credentials,
 * JSON-quoted keys and PEM blocks.
 */
const PATTERNS: RegExp[] = [
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
