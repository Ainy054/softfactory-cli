# asla Softfactory

**Gemini agents that ship software you can trust.** Built in Mongolia for the Google Cloud AI Builder Cup 2026 (team **asla**, track: Future of Work & Enterprise Productivity).

Softfactory is a command-line software factory. Give it a requirement, as one sentence or a spec file, and it returns a merged, tested git repository:

1. **Plan:** Gemini 3.1 Pro splits the requirement into phases and tasks, each with a role (`coder`, `test_writer`).
2. **Build:** each task runs in its own git worktree, with a typed `handoff.json` passed between agents (Gemini 3.7 Flash).
3. **Verify:** tests run in a Docker sandbox. Acceptance tests must fail first and pass after. A Gemini **Quality Inspector** reviews every diff.
4. **Merge:** only tasks that pass are merged. Failures are retried within `--attempt-timeout` and `--run-budget`.
5. **Learn:** every verified result is saved as a sanitized training candidate.

## Demo

```bash
softfactory \
  --strategy=cloud --cloud-provider=agy --planner-provider=agy \
  --cloud-model="Gemini 3.7 Flash (High)" --frontier-model="Gemini 3.1 Pro (High)" \
  --sandbox=auto --attempt-timeout 15 --run-budget 60 \
  "FastAPI service exposing Bank of Mongolia official exchange rates: GET /rates/latest and GET /rates/history?currency=&from=&to=, with a parser module, SQLite cache, and pytest tests using saved HTML fixtures"
```

Result: 5 phases, 7 of 7 tasks merged (parser, SQLite cache, FastAPI routes, plus four test suites and an integration quality gate), and the Quality Inspector passed.

- Live console: `https://<project>.web.app`
- Generated API on Cloud Run: `https://<service>.run.app`
- Demo video: `https://youtu.be/<video-id>`

## Google Cloud services

| Service | Role |
|---|---|
| Gemini 3.1 Pro / 3.7 Flash | Planner, coder, test writer, Quality Inspector |
| Cloud Run | Factory service (`softfactory-api`) and the generated API |
| Firestore | Run history and live task events |
| Firebase Hosting + Auth | Web console with Google sign-in; `/api/**` routed to Cloud Run |
| Cloud Storage | Finished repositories (zip) |

## Repository layout

```
orchestrator/    FastAPI wrapper that runs softfactory-cli and streams progress to Firestore
web/             Firebase Hosting console, firebase.json, firestore.rules
generated-app/   Dockerfile to deploy a generated FastAPI app to Cloud Run
deploy.sh        One-command deploy
```

## Team

- **Buyan Volodya**: platform and engineering lead
- **Ainy Khan**: team member

asla · [asla.mn](https://asla.mn)
