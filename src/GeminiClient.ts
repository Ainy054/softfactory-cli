import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { Task } from './types.js';

export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private proModel: GenerativeModel;
  private flashModel: GenerativeModel;

  constructor(apiKey: string, proModelName: string, flashModelName: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.proModel = this.genAI.getGenerativeModel({ model: proModelName });
    this.flashModel = this.genAI.getGenerativeModel({ model: flashModelName });
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

Output a strictly valid JSON object following this schema:
{
  "feature": "Name of the feature",
  "tasks": [
    {
      "id": "T001",
      "title": "Short title",
      "description": "Detailed implementation instructions for a builder agent",
      "agent_role": "coder" | "test_writer" | "docs" | "devops" | "architect" | "builder",
      "phase": 1,
      "dependencies": [],
      "blockedBy": [],
      "files_hint": ["path/to/file.ts"]
    }
  ]
}

Rules:
- Assign phase numbers so independent tasks share the same phase (they run in parallel).
- Use dependencies/blockedBy to express ordering within a phase.
- Ensure tasks are granular, parallelizable where possible, and include file hints.
`;

    const result = await this.proModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Failed to parse JSON from Gemini response");

    return JSON.parse(jsonMatch[0]);
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
- Tasks with status "done" MUST be kept exactly as-is (id, title, description, phase, dependencies). Their code is already merged — you cannot undo them.
- Tasks with status "pending", "failed", or "rejected" CAN be modified, deleted, or replaced.
- You MAY add new tasks with new IDs (continue the T00X numbering sequence).
- Preserve the "feature" name if the refinement is a tweak; update it only if the scope fundamentally changes.
- Ensure phase numbers and dependencies remain consistent (no dangling references to deleted tasks).
- New/modified tasks must have status "pending" and attempts 0.

Output a strictly valid JSON object:
{
  "feature": "Feature name (same or updated)",
  "tasks": [
    {
      "id": "T001",
      "title": "Short title",
      "description": "Detailed implementation instructions",
      "agent_role": "coder" | "test_writer" | "docs" | "devops" | "architect" | "builder",
      "phase": 1,
      "dependencies": [],
      "blockedBy": [],
      "files_hint": ["path/to/file.ts"],
      "status": "done" | "pending",
      "attempts": 0
    }
  ]
}
`;

    const result = await this.proModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Failed to parse JSON from Gemini refinement response");

    return JSON.parse(jsonMatch[0]);
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

    const result = await this.flashModel.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  }

  async inspectTask(task: Task, diff: string, handoffSummary: string): Promise<{ verdict: 'PASS' | 'FAIL', feedback: string }> {
    const prompt = `
You are the SoftFactory Quality Inspector.
Your task is to review a code diff against a task description and a worker's handoff summary.

Task Description: ${task.description}
Handoff Summary: ${handoffSummary}

Code Diff:
${diff}

Verdict Rules:
1. Does the code fulfill the task?
2. Are there obvious bugs or architectural violations?
3. Are tests included if required?

Output strictly in this format:
VERDICT: [PASS/FAIL]
FEEDBACK: [Your detailed feedback here]
`;

    const result = await this.flashModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
    const feedbackMatch = text.match(/FEEDBACK:\s*([\s\S]*)/i);

    return {
      verdict: (verdictMatch?.[1].toUpperCase() as 'PASS' | 'FAIL') || 'FAIL',
      feedback: feedbackMatch?.[1].trim() || "No feedback provided."
    };
  }
}
