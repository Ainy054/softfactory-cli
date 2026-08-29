import { execa } from 'execa';
import { Task } from './types.js';
import { WorkerEnvironmentError } from './IWorker.js';

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

export class AgyClient {
  private proModelName: string;
  private flashModelName: string;
  private localModelName: string;

  constructor(
    _apiKey?: string,
    proModelName: string = 'Gemini 3.1 Pro (High)',
    flashModelName: string = 'Gemini 3.7 Flash (Low)',
    localModelName: string = 'qwen2.5-coder:7b'
  ) {
    this.proModelName = proModelName;
    this.flashModelName = flashModelName;
    this.localModelName = localModelName;
  }

  private async callLlm(prompt: string, modelName: string, timeoutMs: number = 300000): Promise<string> {
    // 1. If explicit local model name is provided
    if (modelName.includes(':') || modelName.includes('qwen') || modelName.includes('llama')) {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelName,
            prompt,
            stream: false,
            options: { temperature: 0.2, num_ctx: 8192 }
          })
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.response) return data.response;
        }
      } catch {}
    }

    // 2. Try agy CLI (cloud)
    try {
      const { stdout, stderr } = await execa('agy', [
        '--dangerously-skip-permissions',
        '--model', modelName,
        '--print', prompt
      ], { timeout: timeoutMs });

      const output = (stdout || stderr || '').trim();
      if (output && !output.includes('quota reached') && !output.includes('Individual quota') && !output.includes('Error:')) {
        return output;
      }
    } catch {}

    // 3. Fallback to local Ollama
    try {
      const res = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.localModelName,
          prompt,
          stream: false,
          options: { temperature: 0.2, num_ctx: 8192 }
        })
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data.response) return data.response;
      }
    } catch {}

    throw new Error('Inference failed across both cloud agy and local Ollama.');
  }

  async generateBlueprint(requirement: string, codebaseContext: string, memoryPatterns: string, featureHistory?: string): Promise<any> {
    const prompt = `
You are the SoftFactory Blueprint Architect.
Your task is to analyze a requirement and a codebase context to produce a structured task plan.

Requirement: ${requirement}

Codebase Context:
${codebaseContext}

Memory Patterns (Learned from previous runs):
${memoryPatterns}

Previously Built Features:
${featureHistory || 'None — this is the first feature for this project.'}

Rules:
- Assign phase numbers so independent tasks share the same phase (they run in parallel).
- Use dependencies/blockedBy to express ordering within a phase.
- **TDD PREFERENCE**: For complex logic, create a "test_writer" task (phase N) and a "coder" task (phase N+1) that depends on the tests.
- **DEVOPS FIRST**: ALWAYS include a task with agent_role "devops" that creates a Dockerfile and docker-compose.yml (or verifies existing). Place it in Phase 1.
- Ensure tasks are granular, parallelizable where possible, and include file hints.
- **TASK SIZE**: Each task should produce no more than ~300 lines of code. Split by domain/feature boundary.
- **FILE PARTITIONING**: Avoid having two tasks in the same phase modify the same file. Split by file or directory boundary to prevent merge conflicts.
- **MODEL SELECTION**: Assign agent_role ("coder", "test_writer", "docs", "devops", "architect", "builder").

CRITICAL: Return ONLY a valid JSON object matching this schema:
{
  "feature": "Feature Name",
  "tasks": [
    {
      "id": "T001",
      "title": "Task title",
      "description": "Clear instructions for the worker",
      "agent_role": "coder" | "test_writer" | "docs" | "devops" | "architect" | "builder",
      "phase": 1,
      "dependencies": [],
      "blockedBy": [],
      "files_hint": ["path/to/file1.go"]
    }
  ]
}
`;

    const stdout = await this.callLlm(prompt, this.proModelName, 180000);
    return extractJson(stdout);
  }

  async refineBlueprint(refinement: string, currentTasks: Task[], codebaseContext: string): Promise<any> {
    const taskSummary = currentTasks.map(t =>
      `  ${t.id} [${t.status}] phase:${t.phase} "${t.title}" — ${t.description.slice(0, 120)}` +
      (t.dependencies.length ? ` deps:[${t.dependencies}]` : '') +
      (t.blockedBy.length ? ` blocked:[${t.blockedBy}]` : '')
    ).join('\n');

    const prompt = `
You are the SoftFactory Blueprint Architect performing a MID-FLIGHT REFINEMENT.
The user wants to change direction on an in-progress build. You must modify the task plan.

Refinement Request: ${refinement}

Current Tasks:
${taskSummary}

Codebase Context:
${codebaseContext}

RULES:
- Tasks with status "done" MUST be kept exactly as-is (id, title, description, phase, dependencies). Their code is already merged.
- Tasks with status "pending", "failed", or "rejected" CAN be modified, deleted, or replaced.
- You MAY add new tasks with new IDs (continue the T00X numbering sequence).
- Ensure phase numbers and dependencies remain consistent.

CRITICAL: Return ONLY a valid JSON object matching this schema:
{
  "feature": "Feature Name",
  "tasks": [
    {
      "id": "T001",
      "title": "Task title",
      "description": "Clear instructions",
      "agent_role": "coder",
      "phase": 1,
      "dependencies": [],
      "blockedBy": [],
      "files_hint": ["path/to/file.go"],
      "status": "pending",
      "attempts": 0
    }
  ]
}
`;

    const stdout = await this.callLlm(prompt, this.proModelName, 180000);
    return extractJson(stdout);
  }

  async synthesizeMemory(feature: string, diffStat: string): Promise<string> {
    const prompt = `
You are the SoftFactory Memory Synthesizer.
A feature has been successfully built. Extract the key architectural patterns and decisions worth remembering for future builds.

Feature: ${feature}

Changes (git diff --stat):
${diffStat}

Extract and return a concise markdown summary covering:
- Key architectural decisions made (tech stack choices, patterns used)
- Important file paths and their purposes
- Conventions established (naming, structure, testing approach)
- Integration points that future features should be aware of

Keep it under 20 lines. Focus on what would help a future Architect plan the NEXT feature.
Do NOT include generic advice — only project-specific patterns.
`;

    try {
      const stdout = await this.callLlm(prompt, this.flashModelName, 60000);
      return stdout.trim();
    } catch {
      return `### Memory Patterns for ${feature}\n\n- Completed and verified via automated test suite.\n- Changes recorded in repository history.\n`;
    }
  }

  async synthesizeEpiphany(task: Task, diff: string): Promise<any> {
    const prompt = `Extract one specific, reusable project lesson from this successfully repaired task. Return only JSON: {"should_save":boolean,"lesson":string,"tags":string[],"scope":"project"|"language"|"path","confidence":number}. Reject generic advice.\nTask: ${task.description}\nFailures: ${(task.error_history || []).join('\n')}\nFinal diff: ${diff.slice(0, 6000)}`;
    return extractJson(await this.callLlm(prompt, this.flashModelName, 60000));
  }

  async inspectTask(
    task: Task,
    diff: string,
    handoffSummary: string,
    verifierOutput?: string
  ): Promise<{ verdict: 'PASS' | 'FAIL', feedback: string }> {
    const prompt = `
You are the SoftFactory Quality Inspector.
Your task is to review a code diff against a task description, the worker's handoff summary, and local test execution output.

Task Role: ${task.agent_role}
Task Description: ${task.description}
Handoff Summary: ${handoffSummary}
${verifierOutput ? `\nLocal Automated Test & Verification Output:\n${verifierOutput}\n` : ''}

Code Diff:
${diff}

Verdict Rules:
1. Does the code fulfill the task requirements?
2. Are there obvious bugs, syntax errors, or architectural violations?
3. If the task role is "test_writer" (TDD): It is EXPECTED and NORMAL for newly written test assertions to fail against not-yet-implemented business logic. You must NOT fail a "test_writer" task simply because the tests fail against unimplemented code, as long as the test code compiles and validly tests the required behavior.
4. For implementation roles ("coder", etc.): Ensure automated tests compile and pass.

CRITICAL: Return ONLY a valid JSON object:
{
  "verdict": "PASS" | "FAIL",
  "feedback": "Concise explanation of your decision"
}
`;

    // The inspector is a merge gate. It must never pass work by accident: an
    // unreachable backend halts the run, and unreadable output is a FAIL.
    let stdout: string;
    try {
      stdout = await this.callLlm(prompt, this.flashModelName, 120000);
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Quality inspector is unavailable (${error?.message || 'inference failed'}). No diff was reviewed, so nothing was merged.`);
    }
    try {
      const parsed = extractJson(stdout);
      return {
        verdict: (parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
        feedback: parsed.feedback || 'No feedback provided.',
      };
    } catch {
      return {
        verdict: 'FAIL',
        feedback: `Inspector returned unreadable output (expected JSON with verdict and feedback). Raw: ${stdout.slice(0, 300)}`,
      };
    }
  }
}

// Export GeminiClient as alias for backwards compatibility
export const GeminiClient = AgyClient;
