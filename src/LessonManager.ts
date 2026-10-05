import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { Lesson, LessonSchema, Task } from './types.js';
import { redactSecrets } from './redact.js';
export class LessonManager {
  private path: string;
  constructor(baseDir: string) { this.path = path.join(baseDir, '.softfactory', 'lessons.json'); }
  async getRelevant(task: Pick<Task, 'title' | 'description' | 'files_hint' | 'agent_role'>, limit = 5): Promise<string[]> {
    const terms: string[] = `${task.title} ${task.description} ${task.agent_role} ${task.files_hint.join(' ')}`.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const lessons = await this.read();
    const selected = lessons.filter(l => l.status === 'active').map(l => ({ l, score: l.tags.filter(t => terms.includes(t.toLowerCase())).length + (terms.some(t => l.lesson.toLowerCase().includes(t)) ? 1 : 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.l.confidence - a.l.confidence).slice(0, limit);
    if (selected.length) await this.write(lessons.map(l => selected.some(x => x.l.id === l.id) ? { ...l, lastUsedAt: new Date().toISOString(), useCount: l.useCount + 1 } : l));
    return selected.map(x => x.l.lesson);
  }
  async add(raw: Omit<Lesson, 'id' | 'createdAt' | 'useCount' | 'status'>): Promise<boolean> {
    // Evidence quotes failure output and worker summaries verbatim; neither
    // may carry a credential into a file that every future prompt reads.
    const candidate = {
      ...raw,
      lesson: redactSecrets(raw.lesson),
      evidence: { ...raw.evidence, failure: redactSecrets(raw.evidence.failure), resolution: redactSecrets(raw.evidence.resolution) },
    };
    if (candidate.confidence < 0.65 || /ignore (previous|all)|system prompt|api[_ -]?key/i.test(candidate.lesson)) return false;
    const lessons = await this.read(); const normalized = candidate.lesson.toLowerCase().replace(/\W+/g, ' ').trim();
    if (lessons.some(l => l.lesson.toLowerCase().replace(/\W+/g, ' ').trim() === normalized)) return false;
    lessons.push(LessonSchema.parse({ ...candidate, id: `lesson-${Date.now()}`, createdAt: new Date().toISOString(), useCount: 0, status: 'active' })); await this.write(lessons.slice(-200)); return true;
  }
  async getForPlanning(limit = 12): Promise<string> {
    return (await this.read()).filter(l => l.status === 'active').sort((a, b) => b.confidence - a.confidence).slice(0, limit).map(l => `- ${l.lesson}`).join('\n') || 'No verified lessons yet.';
  }
  private async read(): Promise<Lesson[]> { try { return JSON.parse(await fs.readFile(this.path, 'utf8')).lessons.map((l: unknown) => LessonSchema.parse(l)); } catch { return []; } }
  /**
   * A fixed .tmp name races: four workers in one phase share this file, and one
   * renaming it out from under another produced ENOENT mid-run. Give each write
   * its own temp file, and never let a lesson write fail a task.
   */
  private async write(lessons: Lesson[]): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ lessons }, null, 2));
      await fs.rename(tmp, this.path);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}
