<img src="docs/assets/logo.png" alt="Bear Metal" width="160" />

# bear-metal

Background coding agent. Takes tickets from Linear, hands them to a worker that
solves them with an LLM, and opens a GitHub PR.

## Scope (current)

This repository currently contains one package with a **manager** and **worker**.
The manager polls Linear tickets delegated to the user associated with `LINEAR_API_TOKEN`, looks up the
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
| `LINEAR_API_TOKEN` | yes | — | Linear auth (assignee resolved automatically via viewer query) |
| `GITHUB_APP_ID` | yes | — | GitHub App id (numeric) |
| `GITHUB_APP_PRIVATE_KEY` | yes | — | App private key PEM (`\n` for newlines) |
| `GITHUB_APP_INSTALLATION_ID` | yes | — | installation id (numeric) |
| `WORKSPACE_BUILDER_COMMAND` | yes* | — | Inline bash script for workspace setup (see [Workspace Builder](#workspace-builder)) |
| `WORKSPACE_BUILDER_PATH` | yes* | — | Path to a workspace builder script file (see [Workspace Builder](#workspace-builder)) |
| `DATABASE_URL` | no | `sqlite:./bear-metal-manager.sqlite` | task queue database; supports `sqlite:<path>` and `postgres://...` |
| `WORKER_CONCURRENCY` | no | `5` | max tickets worked in parallel |
| `POLL_INTERVAL_MS` | no | `60000` | poll cadence |
| `PORT` | no | `3000` | health server port |
| `LOG_LEVEL` | no | `info` | pino log level |
| `LOG_PRETTY` | no | `false` | colorized, human-readable logs (dev); JSON when false |

*Exactly one of `WORKSPACE_BUILDER_COMMAND` or `WORKSPACE_BUILDER_PATH` must be set.

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

## Workspace Builder

Before invoking the coding agent, the worker runs a **workspace builder** to
clone and set up the target repository. You must provide one via env var.

Bear-metal creates `AGENT_WORKDIR`, runs the builder, then runs the agent inside
`AGENT_WORKDIR`. The builder must populate that directory and exit 0 on success.
A non-zero exit aborts the task.

**Input env vars passed to the builder:**

| Var | Example |
|-----|---------|
| `AGENT_WORKDIR` | `/tmp/bear-metal-workspace-DEN-123/agent` |
| `TICKET_ID` | `DEN-123` |
| `TICKET_TITLE` | `Fix the auth bug` |
| `TICKET_URL` | `https://linear.app/...` |
| `TICKET_TEAM` | `DEN` |
| `TICKET_TAGS` | `repo:backend,priority:high` (comma-separated Linear labels) |
| `TICKET_DESCRIPTION` | full ticket body |

### Single repo (`WORKSPACE_BUILDER_COMMAND`)

One-liner — no file to mount:

```bash
WORKSPACE_BUILDER_COMMAND=git clone git@github.com:your-org/your-repo "$AGENT_WORKDIR"
```

### Umbrella repo with sub-repos (`WORKSPACE_BUILDER_COMMAND`)

Clone the umbrella, then run its sub-repo clone script:

```bash
WORKSPACE_BUILDER_COMMAND=<<'EOF'
git clone git@github.com:your-org/umbrella "$AGENT_WORKDIR"
cd "$AGENT_WORKDIR" && scripts/clone-repos.sh
EOF
```

### Dynamic multi-repo routing by tag (`WORKSPACE_BUILDER_PATH`)

For complex logic, mount a script file and point to it:

```bash
WORKSPACE_BUILDER_PATH=/scripts/build-workspace.sh
```

```bash
#!/usr/bin/env bash
set -euo pipefail

if echo "$TICKET_TAGS" | grep -q "repo:frontend"; then
  git clone git@github.com:your-org/frontend "$AGENT_WORKDIR"
elif echo "$TICKET_TAGS" | grep -q "repo:backend"; then
  git clone git@github.com:your-org/backend "$AGENT_WORKDIR"
else
  git clone git@github.com:your-org/monorepo "$AGENT_WORKDIR"
fi
```

## Develop

```bash
npm install      # install workspace deps
npm run build    # type-check + compile all packages
npm test         # run unit tests
```

## Dashboard DB

The dashboard backend (`src/backend/`) reads and writes its own database — separate from the
manager's task queue. Pick the engine by URL scheme via `BEAR_METAL_DATABASE_URL`:

```
BEAR_METAL_DATABASE_URL=sqlite:./bear-metal.db                    # local dev / tests
BEAR_METAL_DATABASE_URL=postgres://user:pass@host:5432/bear_metal # production
```

The schema is created on first connect (`CREATE TABLE IF NOT EXISTS`) — no separate migrate
step. FK enforcement is intentionally disabled at the session level because writes are
best-effort and can arrive out of order (a child row can land before its parent).

The dashboard's `BEAR_METAL_DATABASE_URL` and the manager's `DATABASE_URL` are independent —
they can point at the same Postgres instance (different table sets) or different ones.

## Backfill (dashboard DB)

The dashboard reads from its own SQLite file (`BEAR_METAL_DB_PATH`). If you need
to pre-populate it from history — e.g. after a fresh deploy or to recover from a
corrupted file — run the backfill tool. It walks every Linear ticket delegated
to the agent (across all states, including completed/canceled/merged), enriches
each with the matching GitHub PR(s) + check runs, and writes a coherent ticket
bundle to the dashboard DB.

```bash
# Reads Linear + GitHub credentials from the same env vars the manager uses.
BEAR_METAL_DB_PATH=./bear-metal.db npx tsx src/backend/backfill/index.ts

# Flags
#   --dry-run      Read everything, write nothing; print the would-be summary.
#   --limit N      Stop after N tickets (useful for testing).
#   --verbose      Per-ticket log lines instead of just a final summary.
```

Re-runs are safe — tickets already in the DB are left untouched, including
all of their runs / PRs / CI runs / events. Only newly-delegated tickets get
inserted on subsequent runs.
