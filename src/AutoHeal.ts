import { jsonrepair } from 'jsonrepair';
import { execa } from 'execa';
import path from 'node:path';

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
   * Automatically formats code using Prettier or gofmt if available.
   * Runs silently and swallows errors so it doesn't interrupt the agent.
   */
  static async formatCode(worktreePath: string, filepath: string): Promise<void> {
    const ext = path.extname(filepath).toLowerCase();
    const fullPath = path.resolve(worktreePath, filepath);

    try {
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        await execa('npx', ['--no-install', 'prettier', '--write', fullPath], { cwd: worktreePath });
      } else if (ext === '.go') {
        // use goimports if available, fallback to gofmt
        try {
          await execa('goimports', ['-w', fullPath], { cwd: worktreePath });
        } catch {
          await execa('gofmt', ['-w', fullPath], { cwd: worktreePath });
        }
      }
    } catch {
      // Silently ignore formatting errors. Structural errors will be caught
      // by the TaskVerifier later.
    }
  }
}
