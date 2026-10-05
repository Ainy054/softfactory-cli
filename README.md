# SoftFactory CLI

Multi-agent software delivery factory. Decomposes requirements into dependency-ordered phases, executes tasks in parallel inside isolated Git worktrees via local Ollama models and a cloud provider of your choice, runs each task's tests and acceptance command, reviews the diff, and merges passing work.

**What the isolation boundary actually is.** Workers edit files only inside their git worktree. Every command a model chooses to run, and every test the verifier runs, executes in a throwaway Docker container with the network off, no capabilities, and the worktree as the only writable mount (the main repository is mounted read-only so `git status` works). Without Docker, softfactory refuses to start workers unless you pass `--sandbox=none`, in which case commands run on the host under an allowlist (no shell, no network git, no interpreter preloads, every path argument inside the worktree). The allowlist is a filter, not a boundary; treat `--sandbox=none` as running the model's commands yourself.

## Architecture

```
softfactory "add user authentication"
        │
   [BLUEPRINT]          Antigravity agy (Gemini 3.1 Pro High)
        │                Outputs structured phase plan with graph safety
        ▼
   [WORKSHOP]           Hybrid Parallel Workers in isolated git worktrees
   ┌─────────────────┬──────────────────┬─────────────────┐
   │ T001 (devops)   │ T002 (coder)     │ T003 (tests)    │
   │ Local Qwen 2.5  │ Local Qwen 2.5   │ Local Qwen 2.5  │  (Zero API cost)
   └─────────────────┴──────────────────┴─────────────────┘
        │                    │                   │
   [AUTO-VERIFIER]      Runs language test suite in worktree (go test, npm test, pytest)
        │
   [INSPECTION]         Antigravity agy (Gemini 3.7 Flash) reviews diff + test output
        │
   [MERGE]              Sequential merge of verified tasks + FACTORY_MEMORY.md update
```

### What each gate does
1. **Local-first execution:** routine coding and test writing run on local Ollama models; oversized, protected, or repeatedly failing tasks escalate to the configured cloud provider.
2. **Verifier:** the task's scoped tests run in the sandbox, with a per-ecosystem regression baseline so a task is judged on whether it made the suite worse, not on whether an already-red project is red.
3. **Executed acceptance:** the task's own `verification_command` runs verbatim and its evidence log must end in PASS.
4. **Review:** the configured provider's model reviews the diff; protected diffs get an independent review on the frontier model that never sees the worker's summary; a local run records "mechanical gates only" rather than a review it did not have.
5. **Graph safety and recovery:** same-phase tasks with overlapping files are serialized, state is persisted after every step, and Ctrl-C reconciles worktrees.

---

## Prerequisites

- Git
- Node.js 20+
- Docker (for the sandbox; or pass `--sandbox=none` and accept host execution)
- For local workers: Ollama with `qwen2.5-coder:7b` and `qwen2.5-coder:14b`
- For cloud workers, one of: Antigravity CLI (`agy`), Codex CLI, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`

---

## Usage

```bash
# Default Hybrid Mode (Local Qwen for coders/tests + agy for Blueprint/Review)
softfactory "add REST API with user CRUD"

# Force 100% Local (Ollama planner, worker, and verifier)
softfactory --strategy=local --planner-provider=local "add unit tests for auth module"

# Force Cloud-only via agy
softfactory --strategy=cloud --cloud-model="Gemini 3.7 Flash (High)" "refactor ledger engine"

# Use the authenticated Codex CLI and its configured default model
softfactory --strategy=hybrid --cloud-provider=openai --resume

# Or explicitly choose its fast and frontier tiers
softfactory --strategy=cloud --cloud-provider=openai --cloud-model=<fast-model> --frontier-model=<pro-model> "refactor ledger engine"

# Use the OpenAI Responses API directly (requires OPENAI_API_KEY)
softfactory --strategy=cloud --cloud-provider=openai-api --cloud-model=gpt-5.4 "refactor ledger engine"

# Use the Anthropic Messages API directly (requires ANTHROPIC_API_KEY)
softfactory --strategy=cloud --cloud-provider=anthropic --cloud-model=claude-sonnet-4 "refactor ledger engine"

# Use DeepSeek Cloud (requires DEEPSEEK_API_KEY)
softfactory --strategy=hybrid --cloud-provider=deepseek --cloud-model=deepseek-v4-flash --frontier-model=deepseek-v4-pro "refactor ledger engine"

# Non-interactive / CI mode
softfactory --no-tui "implement transaction reversal endpoint"

# Resume an interrupted build
softfactory --resume
```

---

## CLI Flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--strategy` | Execution strategy (`hybrid`, `local`, `cloud`) | `hybrid` |
| `--local-model` | Local model name for Ollama | `qwen2.5-coder:7b` |
| `--planner-provider` | Blueprint planner (`openai`, `agy`, `deepseek`, or offline `local`) | `openai` (local strategy defaults to `local`) |
| `--cloud-model` | Cloud model name; optional for Codex CLI, which uses its configured default | `Gemini 3.7 Flash (High)` |
| `--frontier-model` | Escalation model after repeated cloud-worker failures; optional for Codex CLI | `Gemini 3.1 Pro (High)` |
| `--cloud-provider` | Cloud execution backend: `agy`, `openai` (Codex CLI), `openai-api`, `anthropic`, or `deepseek` | `agy` |
| `--no-tui` | Plain stdout console output without Ink TUI | Interactive default |
| `--sandbox` | Where model-chosen commands and tests run: `auto` (Docker, refuse without it), `docker`, or `none` (host allowlist only, loud warning) | `auto` |
| `--no-docker` | Skip post-build docker-compose verification of the finished app | Docker auto-detect |
| `DEEPSEEK_API_KEY` | API key for DeepSeek cloud workers/planner | Not set |
| `SOFTFACTORY_TRAINING_CAPTURE=0` | Opt out of sanitized verified candidates and failure lessons in `.softfactory/training-*.jsonl` | Enabled |
| `--plan` | Generate and save plan without immediate execution | `false` |
| `--resume` | Resume active, planned, or paused feature build | `false` |
| `--refine` | Modify an in-progress plan mid-flight | `false` |
| `--mark-done <task-id> ["note"]` | Record that a person completed an `orchestrator` or `user` task; combine with `--resume` to continue | — |
| `--history` | View history of completed features | `false` |

---

## Safety and evidence (4.0)

- **Executor routing.** Every task carries `executor`: `agent` (the default) runs in a worktree worker; `orchestrator` is host or live-system work (secret values, deploys, host config, pushes); `user` is a product decision. Workers never receive the last two. The run prints what is needed, pauses with status `paused`, and continues after `softfactory --mark-done <id> "note" --resume`.
- **Executed acceptance.** A task's `verification_command` is run verbatim in its worktree under the command policy (one allowlisted executable, no shell operators) and logged to `.softfactory/evidence/<feature>/<task>-attempt<N>.log`, ending in `RESULT: PASS` or `RESULT: FAIL`. No PASS, no merge. Each command is also run once at planning time; one that cannot run at all rejects the plan.
- **Protected paths.** Globs in `.softfactory/protected-paths.txt` (one per line, `**` crosses directories) mark tasks as protected: they never run on the light local tier, and their diffs get an independent review on the frontier model that sees the diff, the acceptance criteria, the verification output and the worker's `review_answers`, never the worker's own summary. A diff that touches a protected path is reviewed that way even if the plan did not list it.
- **Per-run metrics.** One JSON line per finished run in `.softfactory/metrics.jsonl`. A failure category seen in two of the last three runs is passed to the planner as an escalation it must answer.
- **Secrets.** Real `.env` files are no longer copied into worktrees (`.env.example` is). Credential files are never committed, and lessons, journals and training records are redacted before they are written.
- **State schema.** `factory.json` carries `schema_version`; a state written by a newer softfactory is refused rather than misread.

---

## Project Structure

```
src/
  index.ts            CLI entry point & signal trap handlers
  Factory.ts          Orchestrator (Phase DAG, P-85 pre-dispatch, worktree coordination)
  GeminiClient.ts     AgyClient (Blueprint planning, refinement, memory & inspection)
  IWorker.ts          Common Worker interface (execute & handoff)
  WorkerRegistry.ts   Hybrid router (Local Qwen vs Cloud agy)
  QwenWorker.ts       Local Ollama worker runner
  AgyWorker.ts        Antigravity CLI cloud worker runner
  TaskVerifier.ts     Automated in-worktree test runner (Go, Node, Python, Rust)
  WorktreeManager.ts  Git worktree lifecycle (create/merge/cleanup)
  DockerVerifier.ts   Post-build container verification
  types.ts            Zod schemas (Task, FactoryState, Handoff)
```

## License

ISC
