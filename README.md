<img src="docs/assets/logo.png" alt="Bear Metal" width="160" />

# bear-metal

Background coding agent. Polls Linear for delegated tickets, solves them with an LLM, and opens a GitHub PR for human review.

## How it works

The **manager** polls Linear tickets assigned to the bot user, maintains a SQL-backed `tasks` table for concurrency control, and monitors open PRs for completion. The **worker** atomically claims a task, clones the target repository via a configurable workspace builder, invokes the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), and writes the result back to the task row.

## Layout

Single package (one process, one container). `manager`, `worker`, and `shared` are folders under `src/`, each with a barrel `index.ts`:

```
src/
  shared/   logger, Linear + GitHub integrations, shared types
  worker/   Pi solver, called in-process by the manager
  manager/  config, in-memory state, ticket handler, scheduler, API server
            └─ index.ts  ← entrypoint (dist/manager/index.js)
  ui/       React dashboard (Vite, separate npm package)
  db/       SQL schema and migrations
```

## Setup

### 1. GitHub App

Bear-metal authenticates as a GitHub App installation. Create one at **github.com → Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Repository permissions**: Contents (R/W), Pull requests (R/W), Metadata (R), Checks (R)
- Leave webhooks disabled — bear-metal polls, it does not receive events

After creating the app:

1. Note the **App ID** on the app settings page → `GITHUB_APP_ID`
2. Under **Private keys** → **Generate a private key** → download the `.pem` file
3. Convert newlines for the env var:
   ```bash
   awk '{printf "%s\\n", $0}' your-key.pem
   ```
   Paste the result into `GITHUB_APP_PRIVATE_KEY`
4. **Install** the app on your org or specific repos (app settings → Install App)
5. After install, the URL contains the installation ID:
   `github.com/settings/installations/123456789` → `GITHUB_APP_INSTALLATION_ID`

### 2. Linear API token

Bear-metal polls as the Linear user whose token you provide. Tickets delegated to that user are picked up automatically.

Go to **Linear → Settings → API → Personal API keys → Create key** → `LINEAR_API_TOKEN`

The bot user must be a full Linear workspace member (not a guest) so it can be assigned tickets.

### 3. LLM credentials

Bear-metal uses [Pi](https://github.com/earendil-works/pi-coding-agent) as its coding agent. Set at least one:

| Var | Provider |
|-----|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI (GPT-4o, o1, …) |
| `GOOGLE_API_KEY` | Google (Gemini) |

### 4. Slack notifications (optional)

Create a Slack app at **api.slack.com/apps → Create New App → From scratch**:

1. Under **OAuth & Permissions → Bot Token Scopes**: add `chat:write` and `chat:write.public`
2. Install to your workspace → copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
3. Get the channel ID: right-click the channel in Slack → **View channel details** → copy the ID at the bottom (e.g. `C0123456789`) → `SLACK_NOTIFICATION_CHANNEL`

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `LINEAR_API_TOKEN` | yes | — | Linear API token (bot user) |
| `GITHUB_APP_ID` | yes | — | GitHub App ID (numeric) |
| `GITHUB_APP_PRIVATE_KEY` | yes | — | App private key PEM (`\n` for newlines) |
| `GITHUB_APP_INSTALLATION_ID` | yes | — | Installation ID (numeric) |
| `WORKSPACE_BUILDER_COMMAND` | yes* | — | Inline bash to clone/setup workspace |
| `WORKSPACE_BUILDER_PATH` | yes* | — | Path to workspace builder script |
| `ANTHROPIC_API_KEY` | †| — | Anthropic API key |
| `OPENAI_API_KEY` | † | — | OpenAI API key |
| `GOOGLE_API_KEY` | † | — | Google API key |
| `DATABASE_URL` | no | `sqlite:./bear-metal.sqlite` | Task queue DB (`sqlite:<path>` or `postgres://…`) |
| `WORKER_CONCURRENCY` | no | `5` | Max parallel tickets |
| `POLL_INTERVAL_MS` | no | `60000` | Poll cadence (ms) |
| `MAX_ITERATIONS` | no | `50` | Max agent cycles per ticket before handing back to human |
| `MAX_WORKER_TIME_MS` | no | `7200000` | Max wall-clock time per session (2 h) |
| `MAX_WORKER_TOKENS` | no | `20000000` | Max tokens per session (20 M) |
| `TASK_HEARTBEAT_INTERVAL_MS` | no | `30000` | Worker heartbeat cadence |
| `TASK_STALE_AFTER_MS` | no | `300000` | Recover a task if no heartbeat for this long |
| `TASK_MAX_RECLAIMS` | no | `3` | Abandon a task row after this many recoveries |
| `BACKEND_PORT` | no | `3100` | API + dashboard server port |
| `SYSTEM_PROMPT_PATH` | no | — | Path to a custom system prompt file |
| `SYSTEM_PROMPT` | no | — | Inline custom system prompt (mutually exclusive with `SYSTEM_PROMPT_PATH`) |
| `SLACK_BOT_TOKEN` | no | — | Slack bot OAuth token (`xoxb-…`) |
| `SLACK_NOTIFICATION_CHANNEL` | no | — | Slack channel ID or `#channel-name` |
| `LOG_LEVEL` | no | `info` | pino log level |
| `LOG_PRETTY` | no | `false` | Human-readable logs for local dev |

*Exactly one of `WORKSPACE_BUILDER_COMMAND` or `WORKSPACE_BUILDER_PATH` must be set.

†At least one LLM key is required.

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

`worker_id IS NULL AND result_status IS NULL` means the row has not been acquired. `worker_id IS NOT NULL AND result_status IS NULL` means a worker is running it. `result_status IS NOT NULL` is the return value from the worker's dispatch function, with the full dispatch result in `result_json`.

Each dispatch attempt is a separate row. The latest row per `ticket_id` is also the manager's durable slot record while `slot_status` is `active` or `parked`; `released` rows no longer occupy concurrency. The manager derives the known PR only from the latest row's `result_json.pr` or `input_json.pr`; it does not scan GitHub branches or commit messages to discover PRs.

## Workspace Builder

Before invoking the coding agent, the worker runs a **workspace builder** to clone and set up the target repository. You must provide one via env var.

Bear-metal creates `AGENT_WORKDIR`, runs the builder, then runs the agent inside `AGENT_WORKDIR`. The builder must populate that directory and exit 0 on success. A non-zero exit aborts the task.

**Input env vars passed to the builder:**

| Var | Example |
|-----|---------|
| `AGENT_WORKDIR` | `/tmp/bear-metal-workspace-ABC-123/agent` |
| `TICKET_ID` | `ABC-123` |
| `TICKET_TITLE` | `Fix the auth bug` |
| `TICKET_URL` | `https://linear.app/...` |
| `TICKET_TEAM` | `ABC` |
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

## Custom system prompt

Bear-metal injects a default system prompt with coding-agent instructions. You can extend it:

```bash
# File-based (system-prompt.md is gitignored by default)
SYSTEM_PROMPT_PATH=./system-prompt.md

# Or inline
SYSTEM_PROMPT="Always write tests. Prefer small, focused PRs."
```

Set at most one. The custom prompt is appended to the default.

## Develop

```bash
npm install      # install dependencies
npm run build    # type-check + compile
npm test         # run tests
```

Run the full stack (manager + UI dev server):

```bash
npm run dev:all   # manager on :3100, UI on :5273
```

Or run just the manager (no UI):

```bash
npm run dev
```
