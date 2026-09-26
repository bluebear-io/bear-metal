<img src="logo.png" alt="Bear Metal" />

---

# Bear Metal

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/bluebear-io/bear-metal/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/bluebear-io/bear-metal/actions/workflows/build-and-deploy.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/bluebear-io/bear-metal/badge)](https://securityscorecards.dev/viewer/?uri=github.com/bluebear-io/bear-metal)
[![GitHub release](https://img.shields.io/github/v/release/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/releases/latest)
[![GitHub issues](https://img.shields.io/github/issues/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/issues)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub last commit](https://img.shields.io/github/last-commit/bluebear-io/bear-metal)](https://github.com/bluebear-io/bear-metal/commits/main)

Autonomous coding agent. Picks up tasks from Linear, implements them, and opens pull requests ready to merge. Runs continuously in the background.

## Table of contents

- [How to deploy](#how-to-deploy)
- [Configuration module](#configuration-module)
- [Task customization](#task-customization)
- [Environment variables](#environment-variables)
- [Quick guides](#quick-guides)
  - [GitHub App](#github-app)
  - [Linear](#linear)
  - [Anthropic](#anthropic)
  - [OpenAI](#openai)
  - [Google](#google)
  - [Amazon Bedrock](#amazon-bedrock)
  - [Slack](#slack)
- [Contributing & local dev](#contributing--local-dev)

## How to deploy

1. [Create GitHub Apps](#github-app).
2. [Create Linear OAuth apps](#linear).
3. Optionally [create Slack apps](#slack).
4. Write a trusted [configuration module](#configuration-module) that supplies the required deterministic integrations, any optional agent integrations, enabled LLM providers, and task customization.
5. Make that module available to the process and set `BEAR_METAL_CONFIG_FILE` to its path.
6. Optionally configure persistent PostgreSQL in the module.
7. Deploy the [public image](https://ghcr.io/bluebear-io/bear-metal) (`ghcr.io/bluebear-io/bear-metal:latest`) or run from source with `npm start`. Use a derived image or package-based configuration when the module needs third-party dependencies.

---

## Configuration module

`BEAR_METAL_CONFIG_FILE` must point to an absolute or working-directory-relative `.js`, `.mjs`, `.ts`, or `.mts` ESM module. There is no default or discovery path. Bear Metal imports the module once at startup and validates its default export. Import and structural errors stop startup; task-hook, selected-provider, secret, and workspace errors fail the current attempt through the normal reclaim lifecycle.

The module is trusted deployment code. Bear Metal does not transpile it, install its dependencies, or sandbox it. Native TypeScript must use erasable syntax supported by Node.js 24.12+. A standalone file can use Node built-ins and global `fetch`; configurations that need packages should be deployed as an ordinary package or in a derived image so their imports resolve normally.

[**Canonical configuration, task, and customization types →**](src/customization/types.ts)

The default export supplies required Linear and GitHub settings, the key-based LLM provider registry, and `customizeTask`. Slack, database, `maxIterations`, `ciDeferralMaxMs`, and `shouldRetryCi` are optional.

Secret getters are lazy and may read environment variables, files, workload APIs, or secret managers. Bear Metal owns the vendor clients and consumes each value only where the corresponding integration is used. `agentIntegrations` and each vendor inside it are optional and independent of the top-level deterministic integrations. Omitting an agent vendor means its tools are not shown to the coding agent. Omitting top-level `slack` disables notifications, while omitting database uses `sqlite:./data/bear-metal.sqlite`. `maxIterations` defaults to 50. `ciDeferralMaxMs` controls how long the manager waits for PR validation before sending a delayed-validation notification and defaults to 60 minutes.

`shouldRetryCi(status)` receives each pull request's CI status and may return a boolean or a Promise of one: `true` dispatches another iteration for CI, `false` does not. If omitted, Bear Metal retries when any check run or commit status failed. Other dispatch reasons, such as review comments and merge conflicts, are unaffected. The status includes `context.failedCheckRuns` and `context.failedStatuses` for deployment-specific filtering.

Example standalone JavaScript configuration:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export default {
  ciDeferralMaxMs: 60 * 60 * 1000,
  linear: {
    clientId: requiredEnv("LINEAR_CLIENT_ID"),
    oauthScopes: "read,write,app:assignable,app:mentionable",
    getClientSecret: () => requiredEnv("LINEAR_CLIENT_SECRET"),
  },
  github: {
    appId: 12345,
    installationId: 67890,
    getPrivateKey: () => requiredEnv("GITHUB_APP_PRIVATE_KEY"),
  },
  agentIntegrations: {
    github: {
      appId: Number(requiredEnv("AGENT_GITHUB_APP_ID")),
      installationId: Number(requiredEnv("AGENT_GITHUB_INSTALLATION_ID")),
      getPrivateKey: () => requiredEnv("AGENT_GITHUB_APP_PRIVATE_KEY"),
    },
    linear: {
      clientId: requiredEnv("AGENT_LINEAR_CLIENT_ID"),
      oauthScopes: "read",
      getClientSecret: () => requiredEnv("AGENT_LINEAR_CLIENT_SECRET"),
    },
    slack: {
      getBotToken: () => requiredEnv("AGENT_SLACK_BOT_TOKEN"),
    },
    // HTTPS is the safe default. Opt in only when anonymous public HTTP is required.
    web: { allowHttp: false },
  },
  llmProviders: {
    anthropic: { getApiKey: () => requiredEnv("ANTHROPIC_API_KEY") },
  },
  async customizeTask(task) {
    return {
      llm: { provider: "anthropic", model: "claude-opus-4-6" },
      async buildWorkspace({ workspacePath, signal }) {
        await exec("git", ["clone", "https://github.com/example/repository", workspacePath], { signal });
      },
      additionalSystemPrompt: task.priority === "urgent"
        ? "Prioritize the smallest safe change."
        : undefined,
      limits: { maxDurationMs: 7_200_000, maxTokens: 20_000_000 },
    };
  },
};
```

The same module may be `.mts`; use the canonical source above as the typing reference and, in a user-managed package, apply `satisfies BearMetalConfig`. A package-based configuration may also import a secret-manager SDK. Bear Metal never logs or persists configuration objects, hook results, or resolved secrets.

## Task customization

`customizeTask` receives the deeply frozen, tracker-neutral [`Task` contract](src/customization/types.ts). It includes normalized task identity, workflow, priority, labels, project, assignee, timestamps, discussion, relations, repositories, run context, and pull-request context. It contains no Linear/Octokit objects, raw provider payloads, credentials, or service clients.

The hook must return an LLM provider/model and an async `buildWorkspace({ workspacePath, signal })`. It may also return `additionalSystemPrompt` and independent duration/token limits. See the canonical source for the exact nested DTO and return shapes.

`llmProviders` is required and may be empty. It contains only key-based providers: Anthropic, OpenAI, and Google entries require lazy `getApiKey` functions. Only the key-based provider selected by `customizeTask` is resolved; selecting one without an entry fails that task with the exact configuration entry to add. Bedrock is not registered here because it uses the ambient AWS SDK credential chain.

Bear Metal creates `workspacePath`, calls `buildWorkspace` with a ten-minute abort signal, requires a non-empty result, and removes its owned task workspace after success or failure. Builder code is responsible for cloning and authentication. The core Bear Metal system prompt is immutable; a truthy `additionalSystemPrompt` is appended. Limit fields independently default to 7,200,000 ms and 20,000,000 tokens.

Agent shell commands use a dedicated cache-only `HOME` under `~/.bear-metal/cache-home`; it survives task workspace cleanup and is separate from the service user's normal home and temporary Git credentials. The workspace command guard is not an operating-system sandbox, so deployments must still isolate the worker process from host secrets.

## Environment variables

Bear Metal itself reads only these deployment and process settings:

| Variable | Required | Default | Purpose |
|---|---:|---|---|
| `BEAR_METAL_CONFIG_FILE` | yes | — | Trusted configuration module path |
| `WORKER_CONCURRENCY` | no | `5` | Maximum parallel tasks |
| `POLL_INTERVAL_MS` | no | `60000` | Linear polling cadence |
| `TASK_HEARTBEAT_INTERVAL_MS` | no | `30000` | Worker heartbeat cadence |
| `TASK_STALE_AFTER_MS` | no | `300000` | Reclaim threshold for a task without a heartbeat |
| `TASK_MAX_RECLAIMS` | no | `3` | Maximum recoveries before abandoning a task row |
| `BEAR_METAL_WORKSPACE_DIR` | no | `~/.bear-metal/workspace` | Parent directory for task workspaces |
| `BACKEND_PORT` | no | `3100` | API and dashboard server port |
| `API_ONLY` | no | `false` | Disable serving the built UI |
| `LOG_LEVEL` | no | `info` | Pino log level |
| `LOG_PRETTY` | no | `false` | Human-readable local logs |
| `TEST_TICKET_ID` | no | — | Restrict local polling to one ticket |

`AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, and standard AWS credential-chain variables are inputs to the AWS SDK/embedded agent. `AWS_BEDROCK_FORCE_CACHE` controls embedded Bedrock prompt caching. Bear Metal does not reinterpret them. `APP_VERSION` is a UI build input; `BACKEND_URL` is the Vite development proxy target.

Integration credentials, database URL, max iterations, provider/model selection, prompt additions, limits, and workspace behavior have no Bear Metal environment-variable fallback. Your configuration module may independently choose to read environment variables.

See [`.env.example`](.env.example) for the process-level variables.

---

## Quick guides

### GitHub App

Create GitHub Apps from **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. See [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

The first app is required. The Bear Metal harness uses it for trusted repository operations needed to submit code changes, including pushing branches, opening pull requests, and responding to reviews. Its credentials are never exposed to the coding agent. Configure it with the top-level `github` fields and grant access only to repositories Bear Metal should modify.

1. Create the app, select **Only on this account**, and leave webhooks disabled because Bear Metal polls.
2. Under **Repository permissions**, grant **Metadata: Read**, **Contents: Read and write**, **Pull requests: Read and write**, and **Checks: Read**.
3. On the app settings page, copy **App ID** into `github.appId`.
4. Under **Private keys**, select **Generate a private key** and make `github.getPrivateKey` return the downloaded PEM through your secret source. If storing it as one line, preserve newlines:

   ```bash
   awk '{printf "%s\\n", $0}' your-key.pem
   ```

5. Open **Install App**, install it on the organization, and choose all or selected repositories.
6. Copy the numeric installation ID from the installation URL, such as `github.com/settings/installations/123456789`, into `github.installationId`.

The second app is optional. When configured as `agentIntegrations.github`, it gives the coding agent runtime GitHub tools while letting you fine-tune exactly which repositories and GitHub surfaces it can access. Omit it and the agent receives neither `github_read` nor `github_dispatch`; it can still work with the source already cloned into its workspace.

1. Create and install a separate GitHub App using the same ID, key, and installation steps above.
2. Grant **Metadata: Read** plus read permissions for every surface the agent should inspect, such as **Contents**, **Pull requests**, **Issues**, **Checks**, **Commit statuses**, and **Actions**.
3. Grant **Actions: Read and write** only if the agent may dispatch workflows. GitHub groups dispatch with broader Actions-write permission; Bear Metal exposes only configured workflow dispatches.
4. Configure its App ID, installation ID, and private-key getter under `agentIntegrations.github`.
5. To expose `github_dispatch`, also configure its `repositories`, `workflows`, and `refs` policy. Without that policy, only `github_read` is exposed.

Repository selection and app permissions jointly bound both agent GitHub tools. Bear Metal mints and refreshes the Agent GitHub App's installation token because GitHub installation tokens expire after one hour. `github_read` can only issue GET requests, while `github_dispatch` can only invoke configured workflow-dispatch targets.

### Linear

Create Linear apps under **Linear → Settings → API → OAuth applications**. See [Linear OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication).

The first app is required. The Bear Metal harness uses it to find delegated work, read ticket context, update ticket state, post comments, and hand completed work back. Its credentials are never exposed to the coding agent. Configure it with the top-level `linear` fields.

1. Create a private OAuth application for the Bear Metal workspace.
2. Enable **Client credentials tokens**, **Assignable**, and preferably **Mentionable**.
3. Copy its client ID into `linear.clientId` and return its client secret from `linear.getClientSecret`.
4. Configure `linear.oauthScopes` as `read,write,app:assignable,app:mentionable`.
5. Generate the first client-credentials token by starting Bear Metal, then use the app details page to grant its app actor access to the teams it should manage.

The second app is optional. When configured as `agentIntegrations.linear`, it exposes `linear_read` and lets you independently control which Linear data the coding agent can inspect. Omit it and the agent receives no Linear runtime tool; deterministic ticket orchestration continues normally.

1. Create a separate private OAuth application and enable **Client credentials tokens**.
2. Copy its client ID and secret into `agentIntegrations.linear`.
3. Configure the stable scope `read`.
4. Start Bear Metal once to generate the app actor, then grant that actor access only to teams the coding agent may read.

Both profiles use independent token providers and caches. Bear Metal exchanges each profile's credentials for an app-actor token valid for roughly 30 days and re-mints it automatically, so operators do not rotate generated app tokens manually. Keep each profile's scope set stable because changing it revokes existing app tokens.

The agent must be a full Linear workspace member, not a guest.

> **Delegation model:** Bear Metal picks up tickets delegated to the bot user, not merely assigned. In Linear, open a ticket, choose **Delegate**, and select the bot account. The original assignee stays on the ticket; Bear Metal works on their behalf and hands it back when done.

### Anthropic

Create a key in the [Anthropic Console](https://console.anthropic.com), register `llmProviders.anthropic.getApiKey`, and select `{ provider: "anthropic", model: "..." }` from `customizeTask`.

### OpenAI

Register `llmProviders.openai.getApiKey` and select `{ provider: "openai", model: "..." }` from `customizeTask`.

### Google

Register `llmProviders.google.getApiKey` and select `{ provider: "google", model: "..." }` from `customizeTask`.

### Amazon Bedrock

Select `{ provider: "amazon-bedrock", model: "..." }` from `customizeTask`. Do not add Bedrock to `llmProviders`; authentication is ambient through the AWS credential chain, for example an ECS task role, IRSA, profile, IAM keys, or `AWS_BEARER_TOKEN_BEDROCK`.

For example, route tasks carrying a `research` label to Bedrock:

```js
async customizeTask(task) {
  const research = task.labels.some((label) => label.toLowerCase() === "research");
  return {
    llm: research
      ? { provider: "amazon-bedrock", model: "your-bedrock-model-or-inference-profile" }
      : { provider: "anthropic", model: "your-anthropic-model" },
    async buildWorkspace({ workspacePath, signal }) {
      // Clone or prepare the task workspace here.
    },
  };
}
```

`AWS_REGION` selects the region. `AWS_BEDROCK_FORCE_CACHE=1` forces prompt-cache points for application inference-profile ARNs. The runtime identity needs the appropriate Bedrock invocation permissions for the selected model or inference profile; configure those permissions through your deployment IaC.

The selected provider and model appear in the `selected task LLM` log entry and completed-run usage. Run the routing regression tests locally with:

```bash
npm test -- --run src/worker/dispatch.test.ts
```

For a deployed smoke test, delegate one task for each branch of your `customizeTask` routing. Confirm the provider/model log and dashboard run record match. For Bedrock, you can also verify the invocation in CloudTrail for the task's time window and runtime-role session.

### Slack

Both Slack apps are optional and independent. Create them at [Slack App Management](https://api.slack.com/apps) using **Create New App → From scratch**.

The first app is used only by the trusted harness for deterministic notifications. Omit the top-level `slack` configuration to disable notifications.

1. Under **OAuth & Permissions → Bot Token Scopes**, add `chat:write` and `chat:write.public`.
2. Select **Install to Workspace**, approve the installation, and make `slack.getBotToken` return the **Bot User OAuth Token** (`xoxb-…`) from your secret source.
3. Right-click the target channel, choose **View channel details**, and copy the channel ID shown at the bottom (for example `C0123456789`) into `slack.notificationChannel`.

The second app is used only by the coding agent for Slack reads. Omit `agentIntegrations.slack` and the agent receives no Slack tool.

1. Create a separate Slack app.
2. Under **OAuth & Permissions → Bot Token Scopes**, add only the needed read scopes: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `users:read.email`, and `files:read`.
3. Select **Install to Workspace** or **Reinstall to Workspace**, approve it, and return the resulting `xoxb-…` token from `agentIntegrations.slack.getBotToken`.
4. Invite the bot to every public or private conversation it should read. Scopes do not bypass conversation membership or workspace policy.

Slack's global message search is not available to ordinary bot tokens. It requires a separate user-token and privacy decision; channel discovery and history work with the bot configuration above.

Configure `agentIntegrations.web` to expose `web_get`; omit it to hide the tool. It is anonymous and sends no provider credentials, cookies, client certificates, or ambient proxy authentication. Provider and web responses are untrusted input to the coding agent.

---

## Contributing & local dev

```bash
git clone https://github.com/bluebear-io/bear-metal
cd bear-metal
npm ci
cp .env.example .env
```

Create a local configuration module and set `BEAR_METAL_CONFIG_FILE` in `.env`. Run the full stack (manager and UI dev server):

```bash
npm run dev:all   # manager on :3100, UI on :5273
```

Run only the manager with `npm run dev`. Build and test with:

```bash
npm run build
npm test
```

Validate the manager and UI independently with:

```bash
npm run typecheck

cd src/ui
npm ci
npm run typecheck
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions and pull request guidelines.
