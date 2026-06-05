import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
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

Rules:
- Assign phase numbers so independent tasks share the same phase (they run in parallel).
- Use dependencies/blockedBy to express ordering within a phase.
- **TDD PREFERENCE**: For complex logic, create a "test_writer" task (phase N) and a "coder" task (phase N+1) that depends on the tests.
- **DEVOPS FIRST**: ALWAYS include a task with agent_role "devops" that creates a Dockerfile and docker-compose.yml. Place it in **Phase 1** so the environment is ready for other tasks.
- Ensure tasks are granular, parallelizable where possible, and include file hints.
- **TASK SIZE**: Each task should produce no more than ~300 lines of code. If a feature area (e.g. "API endpoints") would produce more, split it into multiple tasks by domain (e.g. "auth endpoints", "user endpoints", "product endpoints"). Smaller tasks retry cheaper and parallelize better.
- **FILE PARTITIONING**: Avoid having two tasks in the same phase modify the same file. Split by file or directory boundary to prevent merge conflicts.
`;

    const result = await this.proModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            feature: { type: SchemaType.STRING },
            tasks: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  id: { type: SchemaType.STRING },
                  title: { type: SchemaType.STRING },
                  description: { type: SchemaType.STRING },
                  agent_role: { type: SchemaType.STRING, format: 'enum', enum: ['coder', 'test_writer', 'docs', 'devops', 'architect', 'builder'] },
                  phase: { type: SchemaType.INTEGER },
                  dependencies: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                  blockedBy: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                  files_hint: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                },
                required: ['id', 'title', 'description', 'agent_role', 'phase'],
              },
            },
          },
          required: ['feature', 'tasks'],
        },
      },
    });

    return JSON.parse(result.response.text());
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
- **TDD PREFERENCE**: For new logic, prefer creating a "test_writer" task and a "coder" task that depends on it.
- **DEVOPS**: Ensure a devops task exists in an early phase (Phase 1) that creates Dockerfile and docker-compose.yml.
- Preserve the "feature" name if the refinement is a tweak; update it only if the scope fundamentally changes.
- Ensure phase numbers and dependencies remain consistent (no dangling references to deleted tasks).
`;

    const result = await this.proModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            feature: { type: SchemaType.STRING },
            tasks: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  id: { type: SchemaType.STRING },
                  title: { type: SchemaType.STRING },
                  description: { type: SchemaType.STRING },
                  agent_role: { type: SchemaType.STRING },
                  phase: { type: SchemaType.INTEGER },
                  dependencies: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                  blockedBy: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                  files_hint: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                  status: { type: SchemaType.STRING },
                  attempts: { type: SchemaType.INTEGER },
                },
                required: ['id', 'title', 'description', 'agent_role', 'phase', 'status'],
              },
            },
          },
          required: ['feature', 'tasks'],
        },
      },
    });

    return JSON.parse(result.response.text());
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

Set verdict to "PASS" if the code meets all requirements, "FAIL" otherwise.
Provide detailed feedback explaining your decision.
`;

    const result = await this.flashModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            verdict: { type: SchemaType.STRING },
            feedback: { type: SchemaType.STRING },
          },
          required: ['verdict', 'feedback'],
        },
      },
    });

    const parsed = JSON.parse(result.response.text());
    return {
      verdict: (parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
      feedback: parsed.feedback || 'No feedback provided.',
    };
  }
}
