# SoftFactory CLI

A software delivery factory for one repository. You give it a requirement. A planner decomposes it into dependency-ordered tasks with an acceptance command each. Workers, local Ollama models or a cloud model, implement each task in its own git worktree, running every command inside a sandbox. Mechanical gates (the project's tests, the task's acceptance command, scope and sabotage checks) and a reviewer decide what merges. Everything it decides is written down: evidence logs, per-run metrics, and a state file you can resume from.

**What the isolation boundary actually is.** Workers edit files only inside their git worktree. Every command a model chooses to run, and every test the verifier runs, executes in a throwaway Docker container with the network off, no capabilities, a read-only root filesystem, and the worktree as the only writable mount (the main repository is mounted read-only so `git status` works). The container image is the stock language image extended once, locally, with git, ripgrep and make (`softfactory-sandbox-<lang>`), so what the allowlist promises a worker is actually installed; an image you name yourself is used as is. Node dependencies are installed for that Linux image, not copied from your machine: once per lockfile, in a container with the network on, into a Docker volume (`softfactory-deps-<hash>`) that is mounted over `node_modules` for every command. Host-installed esbuild, tsx or vitest binaries would otherwise fail inside the container, and they did. `docker volume ls --filter label=softfactory.deps` lists the volumes; remove old ones when a lockfile changes often. Without Docker, softfactory refuses to start workers unless you pass `--sandbox=none`, in which case commands run on the host under an allowlist (no shell, no network git, no inline interpreter code, a preload flag may name a package such as `tsx` but never a file, every path argument inside the worktree). The allowlist is a filter, not a boundary; treat `--sandbox=none` as running the model's commands yourself. A whole coding agent used as the worker (Claude Code, Gemini CLI) runs its own commands under its own permission rules: with the sandbox on, the entire agent runs in a container whose only network exit is a proxy that admits its model API and nothing else; with `--sandbox=none`, it runs on your host and preflight says UNSANDBOXED AGENT.

## How a run works

```
softfactory "add a farewell endpoint"
     │
     ▼
 PLAN        one planner (Codex CLI, Antigravity, DeepSeek, or a local model) returns a
             validated blueprint: phases, files, acceptance criteria, a runnable
             verification_command per task, an executor (agent / orchestrator / user),
             review questions for protected code. Each acceptance command is run once
             here; one that cannot run at all rejects the plan. An interactive run
             then shows the plan and waits for y.
     │
     ▼
 WORKSHOP    ready agent tasks of the earliest open phase run in parallel, one git
             worktree each. Orchestrator and user tasks are parked for a person and
             the run pauses when nothing else can proceed.
     │         worker = the tool loop (read_file, replace_lines, replace_content,
     │                  write_file, run_command, finish_task) over a chat transport:
     │                  Ollama, DeepSeek, OpenAI, Anthropic; or a whole agent:
     │                  Codex CLI, Antigravity, Claude Code, Gemini CLI
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

1. **Plan approval and plan checks.** An interactive run prints the plan and waits for `y` before any worker starts; anything else saves it unstarted for `--refine` or `--resume`. CI, pipes and `--yes` run unattended. Before that, every plan is checked against the repository: a task that renames or removes a symbol must, with the rest of the plan, list every file that uses it, and an acceptance command may only name files its task or its dependencies change. A plan that fails goes back to the planner once with the reasons.
2. **Executor routing.** `agent` tasks go to a worker. `orchestrator` (secrets, deploys, host config, pushes) and `user` (product decisions) tasks never do; the run pauses with status `paused` and continues after `softfactory --mark-done <id> "note" --resume`.
3. **Verifier.** The task's scoped tests run in the sandbox: the test neighbours of the files it edits or creates, or their directory when there are none, with a longer timeout when that means the whole suite. A task is judged on whether it made the suite worse than the base branch, not on whether an already-red project is red.
4. **Executed acceptance.** The task's `verification_command` runs verbatim under the command policy, in the sandbox, and is logged to `.softfactory/evidence/<feature>/<task>-attempt<N>.log` ending in `RESULT: PASS` or `RESULT: FAIL`. No PASS, no merge. A test writer's command is allowed to be red; an unrunnable command is not allowed for anyone.
5. **Diff hygiene, before any review.** A test writer whose diff touches a non-test file is rejected. A handoff whose own `not_done` list names acceptance work is rejected. Added lines that match a rule in `.softfactory/non-negotiables.txt` (`<regex> :: <reason>`, read from the main checkout) are rejected, and reviewers see the rules. A diff that reformats code it did not need to change is rejected: a file fails when most of its deleted lines are unchanged code in a new layout. Every `path:line` a worker cites, in a claim or a review answer, must exist; a fabricated source rejects the task, and claims marked `UNVERIFIED` are carried in the run notes for later tasks.
6. **Review.** Reviewers also classify a failure as mechanical (one correct form, no test could disagree) or logic. One mechanical fix per unprotected task is a micro-fix: the worker repairs exactly those defects without spending an attempt, and every gate and the review run again. Error mapping, expiry rules, auth lists and return values are logic at any size. Hybrid and cloud runs require the configured reviewer to be reachable before anything starts; the verdict records which model issued it. Diffs touching a path in `.softfactory/protected-paths.txt` (or planned as protected) get the blind frontier review. A local run merges on mechanical gates alone and says so.
7. **Budgets.** Each attempt has a wall-clock budget; a worker that overruns is stopped, its partial work stays on the line branch, and the retry continues from it. A run can carry a time budget per invocation and a token budget per feature; exhausting either halts between phases without burning a retry. The same holds for anything that is the environment's fault rather than the task's: a backend that is unreachable, cannot authenticate, or refuses with a usage or rate limit, and a merge refused by uncommitted changes in your checkout. The run halts with the reason, no attempt is charged, and `--resume` continues.
8. **Final gate.** When every task is in, the whole suite runs on the merge target. It blocks only on failures this build introduced: a run whose tallies are no worse than the base branch's, or whose failures pre-date it, passes. A `--resume` with nothing left re-runs it and finishes the run (the pull request is marked ready).
9. **Fork freshness.** Tasks of one phase fork from the same commit and merge one after another. Before merging a branch whose target has moved, softfactory merges the target into it and re-runs its acceptance command on the result. A conflict, or an acceptance that now fails, sends the task back with the files both sides changed; the trial merge is undone. For protected work the combined result also goes back to the blind reviewer (delta review) before it merges.
10. **Wiring census.** At the start of a run softfactory lists exported functions and classes (Go: `New*` constructors) that no non-test code calls. A task that adds one is noted; the final gate fails if the run ends with one the list did not have. Library code that only tests reach is not finished.
11. **Live verification.** A task whose acceptance needs the running system writes it as `orchestrator: <command>`: workers and the per-task gate skip it, and it runs on the host after merge, named after its task. With `.softfactory/uat.json` in the main checkout, a completed run is then built and probed on the host: the build runs with `SOFTFACTORY_RUN_ID` in its environment, each listed artifact must have been rewritten by that build and contain its markers (binary proof), and each probe must reach the real route and match its expectation. Workers cannot edit the file. No file: the run says so rather than claiming a pass.
12. **Model tiers, retries and recovery.** Protected work, and work on security, tenancy, cryptography or money, starts on the frontier tier: its failures are the ones no test reports. A retry is a different prompt: from the second attempt every worker receives the exact signatures of the task's files and a "do not" for each way the task failed before. A worker that crashed or ran out of time, but left work whose acceptance command passes, goes to the gates instead of costing an attempt. Before its first edit a worker may make 12 calls plus one per 200 lines of the task's files, up to 30.
13. **Graph safety and recovery.** Same-phase tasks claiming the same files are serialized. State carries a schema version and is refused rather than misread when written by a newer softfactory. Blocked tasks can be auto-replanned; a failure category seen in two of the last three runs is handed to the planner as something it must change.

## Prerequisites

- Git, Node.js 20+
- Docker, for the sandbox (or `--sandbox=none` and accept host execution)
- Local workers: Ollama with `qwen2.5-coder:7b` and `qwen2.5-coder:14b` (or any tool-capable model via `--local-model`)
- Cloud workers, one of: Antigravity CLI (`agy`), Codex CLI (`openai`), Claude Code (`claude-code`), Gemini CLI (`gemini-cli`), Muse Code (`muse`), or an API key: `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY` (Qwen), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or any OpenAI-compatible endpoint via `SOFTFACTORY_COMPAT_BASE_URL` and `SOFTFACTORY_COMPAT_API_KEY`
- Keys may live in a `.env` in the repository root: it is read at start for names not already exported, never copied into worktrees, never committed

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
softfactory --strategy=cloud --cloud-provider=qwen "refactor ledger engine"                      # qwen3-coder-plus, escalating to qwen3.8-max
SOFTFACTORY_COMPAT_BASE_URL=https://api.moonshot.ai/v1 SOFTFACTORY_COMPAT_API_KEY=... \
  softfactory --strategy=cloud --cloud-provider=openai-compat --cloud-model=kimi-k2.7-code-highspeed "refactor ledger engine"

# Claude Code or Gemini CLI as the worker: inside the agent container with the sandbox on
ANTHROPIC_API_KEY=... softfactory --strategy=cloud --cloud-provider=claude-code "refactor ledger engine"
# ...or on the host under the agent's own permission rules (loud UNSANDBOXED AGENT warning)
softfactory --strategy=cloud --cloud-provider=claude-code --sandbox=none "refactor ledger engine"

# Plan now, execute later; resume; refine a plan mid-flight
softfactory --plan "implement transaction reversal endpoint"
softfactory --resume
softfactory --refine "also reverse the ledger entry"

# Queue plans and start them oldest first once the current run finishes
softfactory --queue "add rate limiting to the API"
softfactory --next

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
| `--sandbox` | Where model-chosen commands and tests run: `auto` (Docker, refuse without it), `docker`, `none` (host allowlist only, loud warning). Stock images are extended once with git, ripgrep and make | `auto` |
| `--cloud-provider` | `agy`, `openai` (Codex CLI), `claude-code`, `gemini-cli`, `muse`, `openai-api`, `anthropic`, `deepseek`, `qwen`, `openai-compat` | `agy` |
| `--cloud-model` | Cloud model; optional for Codex CLI, which uses its configured default | provider default |
| `--frontier-model` | Escalation and blind-review model; optional for Codex CLI | provider default |
| `--local-model` | Ollama model; pins every local tier when set | `qwen2.5-coder:7b` / `14b` tiers |
| `--planner-provider` | `openai` (Codex CLI), `agy`, `claude-code`, `gemini-cli`, `muse`, `deepseek`, `qwen`, `anthropic`, `openai-api`, `openai-compat`, `local` | follows the cloud provider; `local` for a local run |
| `--planner-model` | Planner model override | provider default |
| `--plan` | Save the plan without executing | `false` |
| `--queue <requirement>` | Plan the requirement and park it under `.softfactory/queue/` instead of running it; allowed while another feature is in progress. Start it later with `--next` | `false` |
| `--next` | Start the oldest queued plan (by `created_at`) once nothing is active, `planned` or `paused`; archives the current state first. Takes no requirement | `false` |
| `--resume [feature-id]` | Resume an active, planned or paused build (or restore an archived one) | `false` |
| `--retry-blocked` | With `--resume`, retry blocked and rejected tasks too | `false` |
| `--refine` | Modify an in-progress plan; done tasks are kept verbatim | `false` |
| `--mark-done <task-id> ["note"]` | Record that a person completed an `orchestrator` or `user` task | — |
| `--history` | Completed features | `false` |
| `--second-reviewer <provider/model>` | A second reviewer on another vendor, any provider the inspector accepts (`qwen/qwen3-coder-plus`, `anthropic/claude-sonnet-4`, `openai-compat/<model>`, `claude-code/<model>`, …). Protected diffs need both verdicts; a split on an ordinary diff goes to the blind review | none |
| `--attempt-timeout <minutes>` | Wall-clock budget per worker attempt; an overrun is a task failure that keeps its partial work and escalates | `45` |
| `--run-budget <minutes>` | Wall-clock budget per invocation; the run halts between phases and `--resume` continues | none |
| `--max-tokens <n>` | Token budget per feature across resumes, where backends report usage | none |
| `--verify-run [feature-id]` | Recompute the run journal's hash chain and the evidence files it cites; exit 1 on any mismatch | current build |
| `--issue <n>` | Read the requirement from GitHub issue `n` through `gh`; words after the flags are appended as operator instructions | — |
| `--pr` | Merge passing tasks into `softfactory/<feature>` instead of the base branch, push it, and open a pull request (draft until the run completes) | `false` |
| `--no-tui` | Plain stdout instead of the Ink TUI; the worker trace is printed task-prefixed, which is what a CI log needs | TUI when interactive |
| `--no-docker` | Skip the post-build docker-compose check of the finished app | auto-detect |
| `--no-uat` | Skip `.softfactory/uat.json` at the end of this run | run it when present |
| `--yes` | Start the plan without asking, even in an interactive terminal | ask when interactive |
| `--abandon` | Archive an unfinished feature so a new requirement can start; without it, a different requirement stops instead of resuming someone else's feature | — |
| `--init` | Write starter `worker-context.md`, `uat.example.json` and `protected-paths.txt` into `.softfactory/`; never overwrites | — |

Environment: `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY` (and `DASHSCOPE_BASE_URL`, default the international compatible-mode endpoint), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `META_API_KEY`; `SOFTFACTORY_COMPAT_BASE_URL`, `SOFTFACTORY_COMPAT_API_KEY`, `SOFTFACTORY_COMPAT_LABEL`, `SOFTFACTORY_COMPAT_CONTEXT` for any other OpenAI-compatible endpoint; `SOFTFACTORY_SANDBOX_IMAGE` (or `sandboxImage` in `.softfactory/config.json`) to pick the container image; `SOFTFACTORY_AGENT_IMAGE` (or `agentImage`) for the agent container's image when the project needs more than node in it; `SOFTFACTORY_EGRESS_ALLOW` for extra hosts (`host` or `host:port`, `*.example.com`) the agent container may reach; `SOFTFACTORY_LOCAL_NUM_CTX` for the local context window; `SOFTFACTORY_WORKER_TIMEOUT_MS` (or a per-provider `SOFTFACTORY_<PROVIDER>_TIMEOUT_MS`) for one model turn; `SOFTFACTORY_TRAINING_CAPTURE=0` to opt out of training-record capture.

## A whole agent as the worker

`--cloud-provider=claude-code`, `gemini-cli` or `muse` hands each task to that agent in print mode inside the task's worktree, with the same prompt the tool loop gets: the task, its acceptance command, its review questions, the lessons, and the handoff file to write. The agent brings its own loop, tools and permission system, so softfactory's command policy does not apply to what it runs. Two placements, chosen by the sandbox mode:

- **Sandbox on (default).** The whole agent runs in a container built once from the node image plus the agent's npm package (`softfactory-agent-<name>`). It has the worktree as its only writable mount, no capabilities, a read-only root, and sits on an internal Docker network with no route out. The one other container on that network is an allowlisting CONNECT proxy, bridged to the outside, that admits the agent's API host (plus `ANTHROPIC_BASE_URL`'s host and anything in `SOFTFACTORY_EGRESS_ALLOW`) on port 443 and refuses everything else. Inside, the agent runs with its permission checks off, since the container is the boundary. Only the agent's own credential variable crosses into the container (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `META_API_KEY`). A login kept in the macOS keychain does not reach it: Claude Code's OAuth login lives there, and so does Muse's (its `auth.json` is a pointer the Linux binary rejects). Set the key, or use `--sandbox=none`. Muse's image is built from Meta's launcher, which downloads the Linux binary at build time; `~/.config/muse/auth.json` is offered to that build as a BuildKit secret in case the download needs the account's token. The container has node and git; for a Go or Python project the agent cannot run those tests itself (the verifier still does, in the right image), or set `SOFTFACTORY_AGENT_IMAGE` to an image that has both the toolchain and the agent CLI.
- **`--sandbox=none`.** The agent runs on your host under its own rules: Claude Code with `acceptEdits` and an allowlist of read-only and test commands, Gemini CLI with `auto_edit`, Muse with approvals off and its own sandbox left on. Preflight prints UNSANDBOXED AGENT. Those rules are the agent's, not softfactory's: `cat ~/.ssh/id_rsa` passes a `Bash(cat:*)` rule, and in a probe Muse's default sandbox allowed both an outbound HTTPS request and a read of `~/.ssh`.

Either way the gates are unchanged: the worktree is committed by the orchestrator, verified, the acceptance command executed, the diff reviewed, and only then merged. The agent's token usage counts toward `--max-tokens`, and the attempt budget ends its process.

## Ticket in, pull request out

With `--issue <n>` the requirement is the issue's title and body, read through the GitHub CLI with your own login. With `--pr` the run merges each passing task into `softfactory/<feature>` (created from the base branch) instead of the base branch itself. When the run ends, the orchestrator pushes that branch and opens a pull request: a draft if the run paused or failed with some work merged, ready for review if it completed. Resuming the same feature updates the same pull request. The body carries the task table with each task's review and acceptance result, the tail of every acceptance evidence log, the run metrics, and the journal's head hash so the record can be checked with `--verify-run`.

Workers never see any of this. Network git is refused to them by the command policy; the push and the pull request are orchestrator actions after the gates. If `gh` is missing or logged out, the run still finishes and tells you which local branch holds the work.

`examples/github/softfactory-issue.yml` is a GitHub Actions workflow that runs the factory on any issue labelled `softfactory`, with Docker sandboxing on the runner and the run record uploaded as a build artifact. Copy it into `.github/workflows/` and set one model API key as a secret.

## What it writes

All under `.softfactory/` in the repository (git-ignored):

| Path | Contents |
| :--- | :--- |
| `factory.json` | The run state: feature, tasks, statuses, attempts, inspection results. Versioned. |
| `queue/<feature_id>.json` | Plans parked by `--queue`, waiting for `--next` to move the oldest into `factory.json` |
| `evidence/<feature>/<task>-attempt<N>.log` | The acceptance command, its output, and `RESULT: PASS` or `FAIL` |
| `runs/<feature>/prompts/<task>-attempt<N>.md` | The exact prompt each worker attempt received, redacted; its hash is in the journal |
| `non-negotiables.txt` | Yours to write: project rules no test catches, one `<regex> :: <reason>` per line; checked against every diff's added lines |
| `runs/<feature>/journal.jsonl` | Hash-chained record of the run: accepted plan, assignments, commits, acceptance results with evidence hashes, verdicts from every reviewer, merges with commit ids, budget halts, final metrics. `--verify-run` checks it |
| `metrics.jsonl` | One line per finished run: outcomes, attempts, failure categories, escalations |
| `protected-paths.txt` | Globs (one per line, `**` crosses directories) whose diffs get the blind frontier review |
| `tool-calls.jsonl` | Every tool call a worker made, with arguments and the result it saw |
| `lessons.json`, `FACTORY_MEMORY.md` | Lessons fed back into planning. A lesson is kept only with the check that enforces it, at most three per run and forty active (the least used retire). The memory file stays under 150 lines; older sections move to `FACTORY_MEMORY.archive.md` |
| `handoff-index.tsv` | One row per merged task (title, files, acceptance command, summary); the planner gets the rows most like a new requirement |
| `worker-context.md` | Yours to write, at most 200 lines: the conventions and traps every worker reads first |
| `uat.json` | Yours to write: build, artifacts with markers, setup, probes, teardown (see `--init`) |
| `evidence/<feature>/uat.log` | The live verification transcript, ending `RESULT: PASS` or `FAIL` |
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
