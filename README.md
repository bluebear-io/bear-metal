<img src="docs/assets/logo.png" alt="Bear Metal" width="160" />

# bear-metal

Background coding agent. Takes tickets from Linear, hands them to a worker that
solves them with an LLM, and opens a GitHub PR.

## Scope (current)

This repository currently contains one package with a **manager** and **worker**.
The manager polls Linear tickets delegated to `LINEAR_ASSIGNEE_ID`, looks up the
GitHub PR for active tickets with a known worker-returned PR ref, and maintains
its concurrency slots in the SQL-backed `tasks` table. The worker atomically
acquires a task row, gathers Linear/GitHub context, runs the repository clone
hook, invokes Pi, and writes the dispatch result (`pending` or `done`) back to
that task row.

## Layout

Single package (one process, one container). `manager`, `worker`, and `shared` are
folders under `src/`, each with a barrel `index.ts`:

```
src/
  shared/   logger, Linear + GitHub integrations, shared types
  worker/   Pi solver, called in-process by the manager
  manager/  config, in-memory state, ticket handler, scheduler, health server
            └─ index.ts  ← entrypoint (dist/manager/index.js)
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `LINEAR_API_TOKEN` | yes | — | Linear auth |
| `LINEAR_ASSIGNEE_ID` | yes | — | Linear user id whose tickets the manager works |
| `GITHUB_APP_ID` | yes | — | GitHub App id (numeric) |
| `GITHUB_APP_PRIVATE_KEY` | yes | — | App private key PEM (`\n` for newlines) |
| `GITHUB_APP_INSTALLATION_ID` | yes | — | installation id (numeric) |
| `DATABASE_URL` | no | `sqlite:./bear-metal-manager.sqlite` | task queue database; supports `sqlite:<path>` and `postgres://...` |
| `WORKER_CONCURRENCY` | no | `2` | max tickets worked in parallel |
| `POLL_INTERVAL_MS` | no | `60000` | poll cadence |
| `PORT` | no | `3000` | health server port |
| `LOG_LEVEL` | no | `info` | pino log level |
| `LOG_PRETTY` | no | `false` | colorized, human-readable logs (dev); JSON when false |

The worker also needs Pi model credentials supported by
`@earendil-works/pi-coding-agent`, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
or `GOOGLE_API_KEY`.

## SQL Task Handoff

The manager-to-worker handoff uses a SQL table named `tasks`:

```sql
tasks (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  input_json TEXT NOT NULL,
  worker_id TEXT NULL,
  result_status TEXT NULL,
  result_json TEXT NULL,
  slot_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP NULL,
  released_at TIMESTAMP NULL
)
```

`worker_id IS NULL AND result_status IS NULL` means the row has not been
acquired. `worker_id IS NOT NULL AND result_status IS NULL` means a worker is
running it. `result_status IS NOT NULL` is the return value from the worker's
dispatch function, with the full dispatch result in `result_json`.

Each dispatch attempt is a separate row. The latest row per `ticket_id` is also
the manager's durable slot record while `slot_status` is `active` or `parked`;
`released` rows no longer occupy concurrency. The manager derives the known PR
only from the latest row's `result_json.pr` or `input_json.pr`; it does not scan
GitHub branches or commit messages to discover PRs.

## Clone Hook

The worker runs `scripts/clone-target-repos.sh` inside a per-ticket workspace
before invoking Pi. Keep target-repository setup logic in that script.

## Develop

```bash
npm install      # install workspace deps
npm run build    # type-check + compile all packages
npm test         # run unit tests
```

## Run

```bash
docker compose up --build   # runs the manager; GET /health on $PORT
```
