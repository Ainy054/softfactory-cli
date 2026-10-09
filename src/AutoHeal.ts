import { jsonrepair } from 'jsonrepair';
import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export class AutoHeal {
  /**
   * Attempts to repair hallucinated/malformed JSON.
   * If the repair fails, it gracefully returns the original string.
   */
  static healJson(content: string): string {
    try {
      return jsonrepair(content);
    } catch (e) {
      return content;
    }
  }

  /**
   * Formats the edited file only in the project's own style, and only when
   * that cannot touch lines the worker did not change.
   *
   * It used to run `prettier --write` on every edited JS/TS file whether or
   * not the project used Prettier. In a repository without a Prettier config
   * that rewrote whole files in Prettier's defaults on the first small edit:
   * dogfood issue #4 produced a 3,552-line diff for a few dozen real lines,
   * and four later attempts could not avoid it because the tool re-applied it
   * after every edit. Now JS/TS is formatted only when the project declares a
   * Prettier config AND the file was already Prettier-clean before the edit;
   * Go files are always gofmt'd, the language's canonical form.
   */
  static async formatCode(worktreePath: string, filepath: string, previous?: string | null): Promise<void> {
    const ext = path.extname(filepath).toLowerCase();
    const fullPath = path.resolve(worktreePath, filepath);
    try {
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        if (!await AutoHeal.hasPrettierConfig(worktreePath)) return;
        if (previous) {
          const clean = await execa('npx', ['--no-install', 'prettier', '--check', '--stdin-filepath', fullPath], { cwd: worktreePath, input: previous, reject: false });
          if (clean.exitCode !== 0) return;
        }
        await execa('npx', ['--no-install', 'prettier', '--write', fullPath], { cwd: worktreePath });
      } else if (ext === '.go') {
        try {
          await execa('goimports', ['-w', fullPath], { cwd: worktreePath });
        } catch {
          await execa('gofmt', ['-w', fullPath], { cwd: worktreePath });
        }
      }
    } catch {
      // Formatting is a courtesy; structural errors are the verifier's job.
    }
  }

  /** A Prettier config file, or a "prettier" key in package.json, at the project root. */
  static async hasPrettierConfig(root: string): Promise<boolean> {
    const files = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];
    for (const file of files) {
      if (await fs.access(path.join(root, file)).then(() => true, () => false)) return true;
    }
    try { return Boolean(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).prettier); }
    catch { return false; }
  }
}
