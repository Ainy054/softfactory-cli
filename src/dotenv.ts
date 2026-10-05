import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads KEY=VALUE lines from a .env file. Only the simple grammar: optional
 * `export`, single or double quotes, `#` comments. No interpolation, no
 * multi-line values. Anything else is a dependency this project does not need.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Loads `.env` from a directory into process.env for names not already set,
 * so an exported variable always wins over the file. Returns the names it set.
 * The file itself is never copied into worktrees or committed: see
 * WorktreeManager.isSecretFile.
 */
export async function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  let content: string;
  try { content = await fs.readFile(path.join(dir, '.env'), 'utf8'); }
  catch { return []; }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parseDotEnv(content))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
