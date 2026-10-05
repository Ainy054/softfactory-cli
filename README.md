# SoftFactory CLI

A software delivery factory for one repository. You give it a requirement. A planner decomposes it into dependency-ordered tasks with an acceptance command each. Workers, local Ollama models or a cloud model, implement each task in its own git worktree, running every command inside a sandbox. Mechanical gates (the project's tests, the task's acceptance command, scope and sabotage checks) and a reviewer decide what merges. Everything it decides is written down: evidence logs, per-run metrics, and a state file you can resume from.

**What the isolation boundary actually is.** Workers edit files only inside their git worktree. Every command a model chooses to run, and every test the verifier runs, executes in a throwaway Docker container with the network off, no capabilities, a read-only root filesystem, and the worktree as the only writable mount (the main repository is mounted read-only so `git status` works). Without Docker, softfactory refuses to start workers unless you pass `--sandbox=none`, in which case commands run on the host under an allowlist (no shell, no network git, no interpreter preloads, every path argument inside the worktree). The allowlist is a filter, not a boundary; treat `--sandbox=none` as running the model's commands yourself.

## How a run works

```
softfactory "add a farewell endpoint"
     │
     ▼
 PLAN        one planner (Codex CLI, Antigravity, DeepSeek, or a local model) returns a
             validated blueprint: phases, files, acceptance criteria, a runnable
             verification_command per task, an executor (agent / orchestrator / user),
             review questions for protected code. Each acceptance command is run once
             here; one that cannot run at all rejects the plan.
     │
     ▼
 WORKSHOP    ready agent tasks of the earliest open phase run in parallel, one git
             worktree each. Orchestrator and user tasks are parked for a person and
             the run pauses when nothing else can proceed.
     │         worker = the tool loop (read_file, replace_lines, replace_content,
     │                  write_file, run_command, finish_task) over a chat transport:
     │                  Ollama, DeepSeek, OpenAI, Anthropic; or the Codex / Antigravity CLI
     ▼
 GATES       commit the worktree → declared files exist → no verification sabotage →
             the project's tests, judged against a per-ecosystem baseline → the task's
             acceptance command, executed verbatim, evidence log must end RESULT: PASS
     │
     ▼
 REVIEW      ordinary diff: the configured provider's model reviews diff + evidence
             protected diff: an independent review on the frontier model that never
                             sees the worker's own summary, checking review_answers
             local strategy: no reviewer; the merge is recorded as "mechanical gates only"
     │
     ▼
 MERGE       --no-ff merge of each passing branch, state saved after every step,
             a failed task retries with feedback up the escalation ladder, metrics
             written per run, Ctrl-C reconciles worktrees.
```

### The gates, and what each one actually checks

1. **Executor routing.** `agent` tasks go to a worker. `orchestrator` (secrets, deploys, host config, pushes) and `user` (product decisions) tasks never do; the run pauses with status `paused` and continues after `softfactory --mark-done <id> "note" --resume`.
2. **Verifier.** The task's scoped tests run in the sandbox. A task is judged on whether it made the suite worse than the base branch, not on whether an already-red project is red.
3. **Executed acceptance.** The task's `verification_command` runs verbatim under the command policy, in the sandbox, and is logged to `.softfactory/evidence/<feature>/<task>-attempt<N>.log` ending in `RESULT: PASS` or `RESULT: FAIL`. No PASS, no merge. A test writer's command is allowed to be red; an unrunnable command is not allowed for anyone.
4. **Review.** Hybrid and cloud runs require the configured reviewer to be reachable before anything starts; the verdict records which model issued it. Diffs touching a path in `.softfactory/protected-paths.txt` (or planned as protected) get the blind frontier review. A local run merges on mechanical gates alone and says so.
5. **Budgets.** Each attempt has a wall-clock budget; a worker that overruns is stopped, its partial work stays on the line branch, and the retry continues from it. A run can carry a time budget per invocation and a token budget per feature; exhausting either halts between phases without burning a retry.
6. **Graph safety and recovery.** Same-phase tasks claiming the same files are serialized. State carries a schema version and is refused rather than misread when written by a newer softfactory. Blocked tasks can be auto-replanned; a failure category seen in two of the last three runs is handed to the planner as something it must change.

## Prerequisites

- Git, Node.js 20+
- Docker, for the sandbox (or `--sandbox=none` and accept host execution)
- Local workers: Ollama with `qwen2.5-coder:7b` and `qwen2.5-coder:14b` (or any tool-capable model via `--local-model`)
- Cloud workers, one of: Antigravity CLI (`agy`), Codex CLI (`openai`), `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`

## Usage

```bash
# Hybrid (default): local Ollama for bounded tasks, the cloud provider for large, protected or retried ones
softfactory "add REST API with user CRUD"

# Fully offline: local planner, local workers, mechanical gates only
softfactory --strategy=local --planner-provider=local "add unit tests for auth module"

# Cloud only, via the Antigravity CLI
softfactory --strategy=cloud --cloud-model="Gemini 3.7 Flash (High)" "refactor ledger engine"

# Codex CLI with its configured default model
softfactory --strategy=hybrid --cloud-provider=openai --resume

# The OpenAI, Anthropic or DeepSeek APIs directly, each on the same tool loop
softfactory --strategy=cloud --cloud-provider=openai-api --cloud-model=gpt-5.4 "refactor ledger engine"
softfactory --strategy=cloud --cloud-provider=anthropic --cloud-model=claude-sonnet-4 "refactor ledger engine"
softfactory --strategy=hybrid --cloud-provider=deepseek --cloud-model=deepseek-v4-flash --frontier-model=deepseek-v4-pro "refactor ledger engine"

# Plan now, execute later; resume; refine a plan mid-flight
softfactory --plan "implement transaction reversal endpoint"
softfactory --resume
softfactory --refine "also reverse the ledger entry"

# A person finished an orchestrator/user task
softfactory --mark-done T3 "rotated the key in the vault" --resume

# Ticket in, pull request out: the issue is the requirement, the PR closes it
softfactory --issue 42 --pr --no-tui --strategy=cloud --cloud-provider=anthropic --cloud-model=claude-sonnet-4

# Check a run's record after the fact
softfactory --verify-run f-20261005-abcd

# CI: plain stdout, no TUI
softfactory --no-tui --sandbox=docker "implement transaction reversal endpoint"
```

## CLI flags

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--strategy` | `hybrid`, `local`, `cloud` | `hybrid` |
| `--sandbox` | Where model-chosen commands and tests run: `auto` (Docker, refuse without it), `docker`, `none` (host allowlist only, loud warning) | `auto` |
| `--cloud-provider` | `agy`, `openai` (Codex CLI), `openai-api`, `anthropic`, `deepseek` | `agy` |
| `--cloud-model` | Cloud model; optional for Codex CLI, which uses its configured default | provider default |
| `--frontier-model` | Escalation and blind-review model; optional for Codex CLI | provider default |
| `--local-model` | Ollama model; pins every local tier when set | `qwen2.5-coder:7b` / `14b` tiers |
| `--planner-provider` | `openai` (Codex CLI), `agy`, `deepseek`, `anthropic`, `openai-api`, `local` | follows the cloud provider; `local` for a local run |
| `--planner-model` | Planner model override | provider default |
| `--plan` | Save the plan without executing | `false` |
| `--resume [feature-id]` | Resume an active, planned or paused build (or restore an archived one) | `false` |
| `--retry-blocked` | With `--resume`, retry blocked and rejected tasks too | `false` |
| `--refine` | Modify an in-progress plan; done tasks are kept verbatim | `false` |
| `--mark-done <task-id> ["note"]` | Record that a person completed an `orchestrator` or `user` task | — |
| `--history` | Completed features | `false` |
| `--second-reviewer <provider/model>` | A second reviewer on another vendor. Protected diffs need both verdicts; a split on an ordinary diff goes to the blind review | none |
| `--attempt-timeout <minutes>` | Wall-clock budget per worker attempt; an overrun is a task failure that keeps its partial work and escalates | `45` |
| `--run-budget <minutes>` | Wall-clock budget per invocation; the run halts between phases and `--resume` continues | none |
| `--max-tokens <n>` | Token budget per feature across resumes, where backends report usage | none |
| `--verify-run [feature-id]` | Recompute the run journal's hash chain and the evidence files it cites; exit 1 on any mismatch | current build |
| `--issue <n>` | Read the requirement from GitHub issue `n` through `gh`; words after the flags are appended as operator instructions | — |
| `--pr` | Merge passing tasks into `softfactory/<feature>` instead of the base branch, push it, and open a pull request (draft until the run completes) | `false` |
| `--no-tui` | Plain stdout instead of the Ink TUI | TUI when interactive |
| `--no-docker` | Skip the post-build docker-compose check of the finished app | auto-detect |

Environment: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`; `SOFTFACTORY_SANDBOX_IMAGE` (or `sandboxImage` in `.softfactory/config.json`) to pick the container image; `SOFTFACTORY_LOCAL_NUM_CTX` for the local context window; `SOFTFACTORY_WORKER_TIMEOUT_MS` (or a per-provider `SOFTFACTORY_<PROVIDER>_TIMEOUT_MS`) for one model turn; `SOFTFACTORY_TRAINING_CAPTURE=0` to opt out of training-record capture.

## Ticket in, pull request out

With `--issue <n>` the requirement is the issue's title and body, read through the GitHub CLI with your own login. With `--pr` the run merges each passing task into `softfactory/<feature>` (created from the base branch) instead of the base branch itself. When the run ends, the orchestrator pushes that branch and opens a pull request: a draft if the run paused or failed with some work merged, ready for review if it completed. Resuming the same feature updates the same pull request. The body carries the task table with each task's review and acceptance result, the tail of every acceptance evidence log, the run metrics, and the journal's head hash so the record can be checked with `--verify-run`.

Workers never see any of this. Network git is refused to them by the command policy; the push and the pull request are orchestrator actions after the gates. If `gh` is missing or logged out, the run still finishes and tells you which local branch holds the work.

`examples/github/softfactory-issue.yml` is a GitHub Actions workflow that runs the factory on any issue labelled `softfactory`, with Docker sandboxing on the runner and the run record uploaded as a build artifact. Copy it into `.github/workflows/` and set one model API key as a secret.

## What it writes

All under `.softfactory/` in the repository (git-ignored):

| Path | Contents |
| :--- | :--- |
| `factory.json` | The run state: feature, tasks, statuses, attempts, inspection results. Versioned. |
| `evidence/<feature>/<task>-attempt<N>.log` | The acceptance command, its output, and `RESULT: PASS` or `FAIL` |
| `runs/<feature>/journal.jsonl` | Hash-chained record of the run: accepted plan, assignments, commits, acceptance results with evidence hashes, verdicts from every reviewer, merges with commit ids, budget halts, final metrics. `--verify-run` checks it |
| `metrics.jsonl` | One line per finished run: outcomes, attempts, failure categories, escalations |
| `protected-paths.txt` | Globs (one per line, `**` crosses directories) whose diffs get the blind frontier review |
| `tool-calls.jsonl` | Every tool call a worker made, with arguments and the result it saw |
| `lessons.json`, `FACTORY_MEMORY.md` | Verified lessons and architectural memory fed back into planning |
| `training-*.jsonl` | Sanitized verified trajectories and failure lessons (opt out with the env var) |
| `history.json`, `archive/` | Finished features |

Secrets: real `.env` files are not copied into worktrees (`.env.example` is); credential files are never committed; lessons, journals and training records are redacted before they are written.

## Project structure

```
src/
  index.ts             CLI entry: flags, signal handling
  runMode.ts           Chooses plan / build / resume / refine / mark-done for the TUI and plain modes
  Factory.ts           Orchestrator: planning, the workshop loop, gates, review, merge, metrics
  Planner.ts           Planner interface, planning rules, blueprint validation, provider planners
  WorkerRegistry.ts    Strategy and escalation ladder: which worker and model runs a task
  ToolLoopWorker.ts    The one tool-calling worker: tools, edit checks, stall detection
  ChatTransport.ts     Ollama, OpenAI-compatible (DeepSeek, OpenAI) and Anthropic chat transports
  AgyWorker.ts         Antigravity CLI worker
  CodexWorker.ts       Codex CLI worker
  TextModel.ts         One-prompt-in, text-out backends for the inspector and planners
  Inspector.ts         Diff review, blind review for protected diffs, lesson and memory synthesis
  TaskVerifier.ts      Test runner per ecosystem, regression baselines, the acceptance runner
  commandPolicy.ts     The command allowlist and path policy
  Sandbox.ts           Host and Docker command runners; sandbox mode and image selection
  WorktreeManager.ts   Git worktree lifecycle: create, hydrate, commit, merge, cleanup
  ProtectedPaths.ts    protected-paths.txt globs
  Metrics.ts           Per-run metrics and the recurring-failure rule
  FailurePolicy.ts     Failure categories and when to split or escalate
  LessonManager.ts     Verified lessons
  TrainingDataManager.ts  Sanitized training capture
  DockerVerifier.ts    Post-build docker-compose check of the finished application
  redact.ts            Secret redaction for everything written to disk
  types.ts             Zod schemas: Task, FactoryState, Handoff, events
  components/          Ink TUI
```

## Development

```bash
npm install
npm test          # node:test over src/*.test.ts, including an end-to-end run on a temp git repo
npm run build     # tsc → dist/
```

## License

ISC
