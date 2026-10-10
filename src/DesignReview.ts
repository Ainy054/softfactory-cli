import { createServer } from 'node:http';
import { execa } from 'execa';
import { MOCKUP_DIR } from './IWorker.js';

/** One mockup a designer committed: its task, screen and the file's base name. */
export interface Mockup { task: string; screen: string; file: string }

/**
 * The mockups a branch carries: `<task>-<screen>.html` files under
 * `softfactory-design/mockups` in `git ls-tree -r --name-only <ref>`. Sorted by
 * task then screen, so the index reads in task order.
 */
export async function listMockups(root: string, ref: string): Promise<Mockup[]> {
  const result = await execa('git', ['ls-tree', '-r', '--name-only', ref, '--', MOCKUP_DIR], { cwd: root, reject: false });
  if (result.exitCode !== 0) return [];
  const prefix = `${MOCKUP_DIR}/`;
  const mockups: Mockup[] = [];
  for (const raw of result.stdout.split('\n')) {
    const path = raw.trim();
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    // Only direct children that are named <task>-<screen>.html count; a
    // sub-directory is not a mockup of this review surface.
    if (name.includes('/') || !name.endsWith('.html')) continue;
    const stem = name.slice(0, -'.html'.length);
    const dash = stem.indexOf('-');
    if (dash <= 0 || dash === stem.length - 1) continue;
    mockups.push({ task: stem.slice(0, dash), screen: stem.slice(dash + 1), file: name });
  }
  mockups.sort((a, b) => a.task === b.task ? a.screen.localeCompare(b.screen) : a.task.localeCompare(b.task));
  return mockups;
}

/**
 * A local review surface for a branch's mockups: an index grouped by task,
 * and each mockup served from git. Names are resolved by looking them up in
 * the committed list, never by joining the request into a path, so
 * `/m/../package.json` is a 404 like any other unknown name.
 */
export async function serveMockups(root: string, ref: string, port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const mockups = await listMockups(root, ref);
  const known = new Map(mockups.map(m => [m.file, m]));
  const server = createServer((request, response) => {
    void handle(root, ref, known, (request.url || '/'), request.method, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${boundPort}/`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function handle(
  root: string,
  ref: string,
  known: Map<string, Mockup>,
  requestUrl: string,
  method: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  try {
    if (method !== 'GET' && method !== 'HEAD') { notFound(response); return; }
    let pathname: string;
    try { pathname = new URL(requestUrl, 'http://127.0.0.1').pathname; } catch { notFound(response); return; }
    if (pathname === '/' || pathname === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(indexPage([...known.values()]));
      return;
    }
    const match = pathname.match(/^\/m\/(.+)$/);
    if (!match) { notFound(response); return; }
    let name: string;
    try { name = decodeURIComponent(match[1]); } catch { notFound(response); return; }
    if (!known.has(name)) { notFound(response); return; }
    const content = await gitShow(root, ref, `${MOCKUP_DIR}/${name}`);
    if (content === undefined) { notFound(response); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(content);
  } catch {
    notFound(response);
  }
}

async function gitShow(root: string, ref: string, path: string): Promise<string | undefined> {
  const result = await execa('git', ['show', `${ref}:${path}`], { cwd: root, reject: false, stripFinalNewline: false });
  if (result.exitCode !== 0) return undefined;
  return result.stdout;
}

function notFound(response: import('node:http').ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

function indexPage(mockups: Mockup[]): string {
  const groups = new Map<string, Mockup[]>();
  for (const mockup of mockups) {
    const list = groups.get(mockup.task) || [];
    list.push(mockup);
    groups.set(mockup.task, list);
  }
  const sections = [...groups.entries()].map(([task, items]) =>
    `<section><h2>${escapeHtml(task)}</h2><ul>${items.map(m => `<li><a href="/m/${encodeURIComponent(m.file)}">${escapeHtml(m.screen)}</a></li>`).join('')}</ul></section>`);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Design review</title></head>
<body>
<h1>Design review</h1>
${sections.join('\n') || '<p>No mockups.</p>'}
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
