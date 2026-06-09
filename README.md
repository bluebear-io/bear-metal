# bear-metal

Background coding agent. Takes tickets from Linear, hands them to a worker that
solves them with an LLM, and opens a GitHub PR.

## Scope (current)

This repository currently contains one process with a **manager** and **worker**.
The manager polls Linear tickets tagged `bear-metal`, looks up the GitHub PR for
active tickets, and maintains an in-memory concurrency cap. The worker gathers
Linear/GitHub context, runs the repository clone hook, invokes Pi, and records
either `pending` or `done`.

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
| `LINEAR_LABEL` | no | `bear-metal` | label to filter tickets |
| `GITHUB_APP_ID` | yes | — | GitHub App id (numeric) |
| `GITHUB_APP_PRIVATE_KEY` | yes | — | App private key PEM (`\n` for newlines) |
| `GITHUB_APP_INSTALLATION_ID` | yes | — | installation id (numeric) |
| `WORKER_CONCURRENCY` | no | `2` | max tickets worked in parallel |
| `POLL_INTERVAL_MS` | no | `60000` | poll cadence |
| `PORT` | no | `3000` | health server port |
| `LOG_LEVEL` | no | `info` | pino log level |
| `LOG_PRETTY` | no | `false` | colorized, human-readable logs (dev); JSON when false |

The worker also needs Pi model credentials supported by
`@earendil-works/pi-coding-agent`, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
or `GOOGLE_API_KEY`.

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
