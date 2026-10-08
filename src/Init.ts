import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `softfactory --init`: starter files for the project-owned inputs, as
 * Softhouse ships templates/. Nothing is overwritten. The UAT definition is
 * written as an example because a real uat.json is a gate: an unedited one
 * would fail every run.
 */
const TEMPLATES: Record<string, string> = {
  'worker-context.md': `# Worker context

Every worker reads this first, before its task. Keep it under 200 lines:
conventions and traps a newcomer would get wrong, not documentation.

## Build and test
- Build: (the one command)
- Focused tests: (how to run one test file)

## Conventions
- (naming, error handling, where new modules go)

## Traps
- (the thing that broke last time, and the check that now catches it)
`,
  'uat.example.json': `${JSON.stringify({
    build: 'docker compose up -d --build',
    artifacts: [{ path: 'dist/index.js', contains: [] }],
    setup: [],
    probes: [
      { name: 'health', run: 'curl -fsS http://localhost:8080/health', expect: 'ok' },
      { name: 'the new route, with real auth', run: 'curl -fsS -H "Authorization: Bearer $UAT_TOKEN" http://localhost:8080/api/thing' },
    ],
    teardown: ['docker compose down'],
    timeout_seconds: 600,
  }, null, 2)}
`,
  'protected-paths.txt': `# Globs whose diffs get the blind frontier review and never the light tier.
# One per line; # starts a comment.
# src/auth/**
# src/billing/**
`,
};

export async function initProject(baseDir: string): Promise<Array<{ file: string; written: boolean }>> {
  const dir = path.join(baseDir, '.softfactory');
  await fs.mkdir(dir, { recursive: true });
  const results: Array<{ file: string; written: boolean }> = [];
  for (const [name, content] of Object.entries(TEMPLATES)) {
    const file = path.join(dir, name);
    try {
      await fs.writeFile(file, content, { flag: 'wx' });
      results.push({ file: path.relative(baseDir, file), written: true });
    } catch {
      results.push({ file: path.relative(baseDir, file), written: false });
    }
  }
  return results;
}
