# SoftFactory CLI

Multi-agent code generation factory. Give it a requirement in plain English — it decomposes it into tasks, executes them in parallel via AI agents, reviews the output, and merges the results.

## Architecture

```
softfactory "add user authentication"
        |
   [BLUEPRINT]          Gemini Pro analyzes requirement + codebase
        |                Outputs structured task plan with phases
        v
   [WORKSHOP]           Claude Code executes each task
    T001  T002  T003     in isolated git worktrees (parallel per phase)
     |     |     |
   [INSPECTION]         Gemini Flash reviews each diff
    PASS  PASS  FAIL     PASS -> merge, FAIL -> retry (max 3)
     |     |     |
   [MERGE]              Sequential merge of passed tasks
```

**Three-stage pipeline:**
1. **Blueprint** (Gemini Pro) — Analyzes your requirement and codebase context, generates a structured task plan with phases, dependencies, and agent roles
2. **Workshop** (Claude Code) — Executes tasks in isolated git worktrees. Same-phase tasks run in parallel. Each worker writes a structured handoff file on completion
3. **Inspection** (Gemini Flash) — Reviews each task's diff against its description. PASS merges to your branch, FAIL retries with feedback (up to 3 attempts)

## Prerequisites

- Node.js 20+
- Git
- `GEMINI_API_KEY` environment variable ([Get one](https://ai.google.dev/))
- Claude Code CLI (`npx @anthropic-ai/claude-code` — installed automatically)

## Installation

```bash
# Global install
npm install -g softfactory-cli

# Or run directly
npx softfactory "your requirement"
```

## Usage

```bash
# Interactive TUI mode (default when TTY)
GEMINI_API_KEY=... softfactory "add REST API with user CRUD"

# Plain console output (CI/pipes, or force with flag)
GEMINI_API_KEY=... softfactory --no-tui "add unit tests for auth module"
```

The TUI shows real-time progress: task status with spinners, phase progress bars, and live worker output.

## How It Works

1. You provide a natural language requirement
2. Gemini Pro breaks it into granular, parallelizable tasks with phase ordering
3. For each phase, all ready tasks launch simultaneously in isolated git worktrees
4. Each Claude Code worker implements its task and writes a `handoff.json`
5. Gemini Flash reviews the diff — PASS tasks merge, FAIL tasks retry
6. Once all phases complete, the build is done

**Task scheduling** respects:
- Phase ordering (phase 1 completes before phase 2 starts)
- Explicit dependencies (`dependencies` and `blockedBy` fields)
- Retry limits (max 3 attempts per task)

**State persistence**: All state is saved to `.softfactory/factory.json`. If interrupted, re-running the same command resumes from where it left off.

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Generative AI API key |

Model defaults (configurable in code):
- Blueprint: `gemini-3.1-pro-preview`
- Inspection: `gemini-3.5-flash`

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests (42 tests across 8 suites)
npm test

# Type-check without emitting
npx tsc --noEmit
```

## Project Structure

```
src/
  index.ts            CLI entry point (TUI/no-TUI routing)
  Factory.ts          Main orchestrator (EventEmitter, parallel scheduling)
  GeminiClient.ts     Gemini Pro (blueprint) + Flash (inspection)
  ClaudeWorker.ts     Spawns Claude Code in worktrees
  WorktreeManager.ts  Git worktree lifecycle (create/merge/cleanup)
  types.ts            Zod schemas (Task, FactoryState, Handoff)
  components/
    App.tsx            Top-level Ink app (state management via useReducer)
    Header.tsx         Feature name + status badge
    PhaseProgress.tsx  Phase progress bars
    TaskList.tsx       Task list with status icons + spinner
    WorkerOutput.tsx   Live worker output feed
```

## License

ISC
