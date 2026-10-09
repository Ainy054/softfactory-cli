import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Version pin: 6.0 will change what "completed" means, so a project must not
 * silently move across a major version. The pin lives in
 * `.softfactory/config.json` as `softfactory_version`; every other key there is
 * preserved and the file keeps its 2-space formatting.
 */
const CONFIG_FILE = path.join('.softfactory', 'config.json');
const PIN_KEY = 'softfactory_version';

function configPath(baseDir: string): string {
  return path.join(baseDir, CONFIG_FILE);
}

/** Reads the pinned version, or undefined when the file or the field is absent. */
export async function readPin(baseDir: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath(baseDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const config = JSON.parse(raw);
    const value = config?.[PIN_KEY];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Sets the pin, preserving every other key and 2-space formatting. */
export async function writePin(baseDir: string, version: string): Promise<void> {
  const file = configPath(baseDir);
  let config: Record<string, unknown> = {};
  let raw: string | undefined;
  try { raw = await fs.readFile(file, 'utf8'); } catch { /* no config yet: start one */ }
  if (raw !== undefined) {
    // Never replace a config the project wrote and we cannot read: that would drop its settings.
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${CONFIG_FILE} is not valid JSON; fix it, then pin again.`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${CONFIG_FILE} is not a JSON object; fix it, then pin again.`);
    config = parsed as Record<string, unknown>;
  }
  config[PIN_KEY] = version;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function major(version: string): string {
  return version.split('.')[0] ?? '';
}

/**
 * Not ok only when the major versions differ. A missing pin means no check.
 * The message names both versions and points at `softfactory --adopt`.
 */
export function pinCheck(pinned: string | undefined, current: string): { ok: true } | { ok: false; message: string } {
  if (!pinned || major(pinned) === major(current)) return { ok: true };
  return {
    ok: false,
    message: `This project is pinned to softfactory ${pinned}, but you are running ${current}. `
      + 'Read the release notes, then run `softfactory --adopt` to accept the new major version.',
  };
}
