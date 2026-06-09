# bear-metal

Background coding agent. Takes tickets from Linear, hands them to a worker that
solves them with an LLM, and opens a GitHub PR.

## Scope (current)

This repository currently contains the **manager** half: a service that, once a
minute, fetches Linear tickets tagged `bear-metal`, looks up the GitHub PR for the
tickets it is actively working, and maintains an in-memory record of in-progress
tickets up to a concurrency cap. Per active ticket it invokes a `ManagerTicketHandler`
that delegates to a no-op `worker` stub. Real worker/LLM logic and the ticket state
machine are not implemented yet.

## Layout

Single package (one process, one container). `manager`, `worker`, and `shared` are
folders under `src/`, each with a barrel `index.ts`:

```
src/
  shared/   logger, Linear + GitHub integrations, shared types
  worker/   solver stub (no-op), called in-process by the manager
  manager/  config, in-memory state, ticket handler, scheduler, health server
            └─ index.ts  ← entrypoint (dist/manager/index.js)
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `LINEAR_API_TOKEN` | yes | — | Linear auth |
| `LINEAR_LABEL` | no | `bear-metal` | label to filter tickets |
| `GITHUB_TOKEN` | yes | — | GitHub auth |
| `GITHUB_OWNER` | yes | — | repo owner/org to scan PRs |
| `GITHUB_REPO` | yes | — | repo to scan PRs |
| `WORKER_CONCURRENCY` | no | `2` | max tickets worked in parallel |
| `POLL_INTERVAL_MS` | no | `60000` | poll cadence |
| `PORT` | no | `3000` | health server port |
| `LOG_LEVEL` | no | `info` | pino log level |

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
