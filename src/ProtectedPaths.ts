import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `.softfactory/protected-paths.txt`: one glob per line, `#` comments. A task
 * whose files match, or whose diff turns out to touch one, is "protected":
 * it never runs on the light local tier and its diff gets the blind review.
 * `**` crosses directories, `*` stays within one segment. Test files never
 * count; they get the test-scope rules instead.
 */
export class ProtectedPaths {
  static readonly FILE = path.join('.softfactory', 'protected-paths.txt');
  private readonly matchers: Array<{ glob: string; regex: RegExp }>;

  constructor(globs: string[]) {
    this.matchers = globs
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(glob => ({ glob, regex: ProtectedPaths.toRegex(glob) }));
  }

  static async load(baseDir: string): Promise<ProtectedPaths> {
    try {
      const text = await fs.readFile(path.join(baseDir, ProtectedPaths.FILE), 'utf8');
      return new ProtectedPaths(text.split('\n'));
    } catch {
      return new ProtectedPaths([]);
    }
  }

  static toRegex(glob: string): RegExp {
    // Built in one pass. Sequential string replacements rewrote the `*`
    // inside their own `.*` output, so `**` matched a single segment.
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === '*') {
        if (glob[i + 1] === '*') {
          if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
          else { out += '.*'; i += 1; }
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else {
        out += ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
      }
    }
    return new RegExp(`^${out}$`);
  }

  get size(): number { return this.matchers.length; }

  static isTestFile(file: string): boolean {
    return /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|test_[^/]*\.py|_test\.py)$|(^|\/)tests?\//.test(file);
  }

  /** The globs the file matches, or an empty list. */
  matches(file: string): string[] {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (ProtectedPaths.isTestFile(normalized)) return [];
    return this.matchers.filter(m => m.regex.test(normalized)).map(m => m.glob);
  }

  /** Files from the list that are protected, with the glob that caught each. */
  touched(files: string[]): Array<{ file: string; glob: string }> {
    const hits: Array<{ file: string; glob: string }> = [];
    for (const file of files) {
      for (const glob of this.matches(file)) hits.push({ file, glob });
    }
    return hits;
  }
}
