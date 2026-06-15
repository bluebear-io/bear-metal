<img src="cover.png" alt="Bear Metal in the data center" />

---

# Bear Metal

<img src="logo.png" alt="Bear Metal logo" align="right" width="160" />

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/bluebear-io/bear-metal/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/bluebear-io/bear-metal/actions/workflows/build-and-deploy.yml)
[![CodeQL](https://github.com/bluebear-io/bear-metal/actions/workflows/codeql.yml/badge.svg)](https://github.com/bluebear-io/bear-metal/actions/workflows/codeql.yml)
[![GitHub release](https://img.shields.io/github/v/release/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/releases/latest)
[![GitHub issues](https://img.shields.io/github/issues/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub last commit](https://img.shields.io/github/last-commit/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/commits/main)

Autonomous coding agent. Picks up tasks from Linear, implements them, and opens pull requests ready to merge. Runs continuously in the background.

<br clear="right" />

## How to deploy

1. Create a GitHub App and note your credentials — [GitHub App guide](#github-app)
2. Create a Linear API token — [Linear guide](#linear)
3. Get an API key from at least one LLM provider — [Anthropic](#anthropic) · [OpenAI](#openai) · [Google](#google)
4. Define how bear-metal should clone your repository — [Workspace builder](#workspace-builder)
5. *(optional)* Set up a persistent database — point `DATABASE_URL` at a PostgreSQL instance or a mounted SQLite file. Without this, bear-metal defaults to a local SQLite file that will be lost if the container restarts.
6. *(optional)* Create a Slack app for PR notifications — [Slack guide](#slack)
7. *(optional)* Write a custom system prompt to inject project-specific instructions — [Custom system prompt](#custom-system-prompt)
8. Set up your environment variables — [full list](#environment-variables), example file at [`.env.example`](.env.example)
9. Deploy via the [public image](https://ghcr.io/bluebear-io/bear-metal) (`ghcr.io/bluebear-io/bear-metal:latest`) or from source with `npm start`

---

## Configuration

### Environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `LINEAR_API_TOKEN` | yes | — | Linear API token (bot user) |
| `GITHUB_APP_ID` | yes | — | GitHub App ID (numeric) |
| `GITHUB_APP_PRIVATE_KEY` | yes | — | App private key PEM (`\n` for newlines) |
| `GITHUB_APP_INSTALLATION_ID` | yes | — | Installation ID (numeric) |
| `WORKSPACE_BUILDER_COMMAND` | yes* | — | Inline bash to clone/setup workspace |
| `WORKSPACE_BUILDER_PATH` | yes* | — | Path to workspace builder script |
| `ANTHROPIC_API_KEY` | yes** | — | Anthropic API key |
| `OPENAI_API_KEY` | yes** | — | OpenAI API key |
| `GOOGLE_API_KEY` | yes** | — | Google API key |
| `SYSTEM_PROMPT_PATH` | no | — | Path to a custom system prompt file |
| `SYSTEM_PROMPT` | no | — | Inline custom system prompt (mutually exclusive with `SYSTEM_PROMPT_PATH`) |
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
| `SLACK_BOT_TOKEN` | no | — | Slack bot OAuth token (`xoxb-…`) |
| `SLACK_NOTIFICATION_CHANNEL` | no | — | Slack channel ID or `#channel-name` |
| `LOG_LEVEL` | no | `info` | pino log level |
| `LOG_PRETTY` | no | `false` | Human-readable logs for local dev |

*Exactly one of `WORKSPACE_BUILDER_COMMAND` or `WORKSPACE_BUILDER_PATH` must be set.

**At least one LLM key is required.

Example file at [`.env.example`](.env.example)

### Workspace builder

Before invoking the coding agent, bear-metal runs a workspace builder to clone and prepare the target repository. You must provide one via env var. The builder must populate `AGENT_WORKDIR` and exit 0 on success — a non-zero exit aborts the task.

Examples:

**Single repo:**

```bash
WORKSPACE_BUILDER_COMMAND=git clone git@github.com:your-user/your-repo "$AGENT_WORKDIR"
```
This works if your bear metal deployment always codes within this particular repository.

**Umbrella repo with sub-repos:**

```bash
WORKSPACE_BUILDER_COMMAND=<<'EOF'
git clone git@github.com:your-user/umbrella "$AGENT_WORKDIR"
cd "$AGENT_WORKDIR"
# clone sub repositories inside
EOF
```
This works if your bear metal deployment always codes within a repository that contains other repositories.

**Multi-repo routing by ticket tags:**

For complex logic, write a script file and point to it:

```bash
WORKSPACE_BUILDER_PATH=/scripts/build-workspace.sh
```

`/scripts/build-workspace.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

if echo "$TICKET_TAGS" | grep -q "repo:frontend"; then
  git clone git@github.com:your-user/frontend "$AGENT_WORKDIR/frontend"
fi
if echo "$TICKET_TAGS" | grep -q "repo:backend"; then
  git clone git@github.com:your-user/backend "$AGENT_WORKDIR/backend"
fi
if echo "$TICKET_TAGS" | grep -q "repo:shared"; then
  git clone git@github.com:your-user/shared "$AGENT_WORKDIR/shared"
fi
```
This works when your bear metal deployment handles multiple repositories. Tag each ticket with the repos it touches and the agent wakes up with all of them as subdirectories of `AGENT_WORKDIR`.

**Environment variables passed to the builder:**

| Var | Example |
|-----|---------|
| `AGENT_WORKDIR` | `/tmp/bear-metal-workspace-ABC-123/agent` |
| `TICKET_ID` | `ABC-123` |
| `TICKET_TITLE` | `Fix the auth bug` |
| `TICKET_URL` | `https://linear.app/...` |
| `TICKET_TEAM` | `ABC` |
| `TICKET_TAGS` | `repo:backend,priority:high` (comma-separated Linear labels) |
| `TICKET_DESCRIPTION` | full ticket body |

Bear-metal creates `AGENT_WORKDIR`, runs the builder, then runs the agent inside `AGENT_WORKDIR`.

### Custom system prompt

Bear-metal injects a default system prompt with coding-agent instructions. You can extend it with project-specific context, conventions, or rules:

```bash
# File-based (system-prompt.md is gitignored by default)
SYSTEM_PROMPT_PATH=./system-prompt.md

# Or inline
SYSTEM_PROMPT="Always write tests. Prefer small, focused PRs."
```

Set at most one. The custom prompt is appended to the built in prompt.

---

## Quick guides

### GitHub App

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

### Linear

Bear-metal polls as the Linear user whose token you provide. Tickets delegated to that user are picked up automatically.

Go to **Linear → Settings → API → Personal API keys → Create key** → `LINEAR_API_TOKEN`

The bot user must be a full Linear workspace member (not a guest) so it can be assigned tickets.

> **Delegation model:** bear-metal picks up tickets that are *delegated* to the bot user, not just assigned. In Linear, open a ticket → click the assignee → choose **Delegate** and select the bot account. The original assignee stays on the ticket; bear-metal works it on their behalf and hands it back when done.

### Anthropic

Get an API key from the [Anthropic Console](https://console.anthropic.com) → **API Keys** → **Create Key** → `ANTHROPIC_API_KEY`

### OpenAI

Get an API key from the [OpenAI Platform](https://platform.openai.com) → **API keys** → **Create new secret key** → `OPENAI_API_KEY`

### Google

Get an API key from [Google AI Studio](https://aistudio.google.com) → **Get API key** → `GOOGLE_API_KEY`

### Slack

Create a Slack app at **api.slack.com/apps → Create New App → From scratch**:

1. Under **OAuth & Permissions → Bot Token Scopes**: add `chat:write` and `chat:write.public`
2. Install to your workspace → copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
3. Get the channel ID: right-click the target channel → **View channel details** → copy the ID at the bottom (e.g. `C0123456789`) → `SLACK_NOTIFICATION_CHANNEL`

---

## Contributing & local dev

```bash
git clone https://github.com/bluebear-io/bear-metal
cd bear-metal
npm install
cp .env.example .env   # fill in credentials
```

Run the full stack (manager + UI dev server):

```bash
npm run dev:all   # manager on :3100, UI on :5273
```

Run just the manager (no UI):

```bash
npm run dev
```

Build and test:

```bash
npm run build   # type-check + compile
npm test        # run tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and pull request guidelines.
