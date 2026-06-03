import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { FactoryState, Task } from './types.js';

export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private proModel: GenerativeModel;
  private flashModel: GenerativeModel;

  constructor(apiKey: string, proModelName: string = 'gemini-1.5-pro', flashModelName: string = 'gemini-1.5-flash') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.proModel = this.genAI.getGenerativeModel({ model: proModelName });
    this.flashModel = this.genAI.getGenerativeModel({ model: flashModelName });
  }

  async generateBlueprint(requirement: string, codebaseContext: string, memoryPatterns: string): Promise<any> {
    const prompt = `
You are the SoftFactory Blueprint Architect (using Gemini 3.1 Pro Preview logic).
Your task is to analyze a requirement and a codebase context to produce a structured task plan.

Requirement: ${requirement}

Codebase Context:
${codebaseContext}

Memory Patterns (Learned from previous runs):
${memoryPatterns}

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

Ensure tasks are granular, parallelizable where possible, and include file hints.
`;

    const result = await this.proModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Extract JSON from response (handling potential markdown blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Failed to parse JSON from Gemini response");
    
    return JSON.parse(jsonMatch[0]);
  }

  async inspectTask(task: Task, diff: string, handoffSummary: string): Promise<{ verdict: 'PASS' | 'FAIL', feedback: string }> {
    const prompt = `
You are the SoftFactory Quality Inspector (using Gemini 3.5 Flash logic).
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
