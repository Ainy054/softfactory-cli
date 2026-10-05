/** Pulls a JSON object out of model output: bare, fenced, or embedded in prose. */
export function extractJson<T = any>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch {}
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  throw new Error(`Failed to parse JSON from model output:\n${text.slice(0, 500)}`);
}
