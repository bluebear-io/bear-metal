# How bear-metal works

Bear-metal is an autonomous coding agent. It runs continuously as a long-lived
process, watches Linear for tickets delegated to it, does the coding work, and
opens pull requests on GitHub. A human still owns the ticket — bear-metal
works on their behalf and hands it back when it is done or stuck.

For deployment, configuration, and credential setup, see the top-level
[README](../README.md). This document describes what bear-metal does at
runtime.

## The loop

Bear-metal runs a single scheduler loop on a fixed cadence
(`POLL_INTERVAL_MS`, default 60s). Each tick:

1. **Find work.** Query Linear for every ticket currently *delegated* to the
   bear-metal app-actor (see below), plus any tickets bear-metal was already
   tracking.
2. **Reconcile state.** For each tracked ticket, check the status of the PRs
   bear-metal has already opened for it (merged, closed, review comments,
   failing checks, merge conflicts, human commits on the branch, etc.).
3. **Decide.** Based on the ticket status and PR signals, decide whether to:
   - dispatch a fresh worker run,
   - keep waiting,
   - release the slot back to the human, or
   - mark the ticket completed.
4. **Dispatch.** If a worker run is warranted and a concurrency slot is free
   (`WORKER_CONCURRENCY`, default 5), spawn a worker for that ticket.

The scheduler never runs the coding agent itself — it only decides *when* a
worker should run and *why*. Every actual code change happens inside a
worker.

## Delegation, not assignment

Bear-metal picks up tickets that are **delegated** to its Linear app-actor,
not tickets that are merely assigned to it. In Linear, a human opens a
ticket, clicks the assignee, and chooses **Delegate → bear-metal**. The
original assignee stays on the ticket; bear-metal works it on their behalf.

If the human revokes the delegation mid-flight, the scheduler notices on the
next tick and *parks* the ticket — the running worker (if any) is allowed to
finish its current step, and no new work is dispatched until the ticket is
re-delegated.

Bear-metal will also hand a ticket back on its own when it detects the human
has taken over the PR (for example, by pushing their own commits to the
branch). This is deliberate — it avoids two actors editing the same PR.

## A worker run

When the scheduler dispatches a worker, bear-metal:

1. **Builds the workspace.** Runs the configured
   [workspace builder](../README.md#workspace-builder) with ticket metadata
   in the environment (`TICKET_ID`, `TICKET_TITLE`, `TICKET_TAGS`,
   `TICKET_DESCRIPTION`, …). The builder is responsible for cloning the
   target repo(s) into `AGENT_WORKDIR`.
2. **Starts the coding agent.** Spawns the LLM-driven coding loop
   (Anthropic / OpenAI / Google, depending on which key is configured)
   inside `AGENT_WORKDIR`. The agent has the ticket description, any prior
   PR review context, and the repository's own AGENTS.md / skills to work
   from.
3. **Iterates.** The agent reads files, runs commands, edits code, and
   commits. Each iteration counts against `MAX_ITERATIONS` (default 50);
   the whole run is bounded by `MAX_WORKER_TIME_MS` (default 2h) and
   `MAX_WORKER_TOKENS` (default 20M).
4. **Opens or updates a PR.** When the agent decides it is done, it pushes a
   branch and opens a pull request against the configured base branch. If a
   PR already exists for the ticket (a follow-up run addressing review
   comments, failing tests, or merge conflicts), bear-metal updates that PR
   in place instead of opening a new one.
5. **Heartbeats.** The worker emits a heartbeat every
   `TASK_HEARTBEAT_INTERVAL_MS` (default 30s). If a worker goes silent for
   longer than `TASK_STALE_AFTER_MS` (default 5m), the scheduler reclaims
   the task on a later tick, up to `TASK_MAX_RECLAIMS` (default 3) before
   giving up.

## Reacting to review

Bear-metal treats the PR itself as the conversation with the human. On each
scheduler tick, for every open PR it has produced, it looks at:

- **Merge / close state** — merged means the ticket is done; closed without
  merge means the human abandoned it.
- **Unresolved review comments** — new actionable comments on the PR or the
  associated issue trigger a follow-up worker run.
- **Failing checks** — CI failures trigger a follow-up worker run to fix
  them.
- **Merge conflicts** — trigger a rebase / fix run.
- **Human commits on the branch** — cause bear-metal to step aside and hand
  the ticket back, to avoid conflicting with in-progress human work.

The follow-up worker inherits the ticket context plus a summary of the PR
signals (review threads, failing checks, conflict state) so it can address
them directly rather than starting from scratch.

## Handing back

Bear-metal will return a ticket to its human assignee in any of these cases:

- The PR was merged (success).
- The PR was closed without merge, or the human is committing to the branch
  themselves (human took over).
- The ticket hit `MAX_ITERATIONS` or another resource limit without
  producing a mergeable PR (bear-metal is stuck; needs human review).
- The human revoked the delegation.
- The Linear ticket moved to a terminal state (Done / Canceled / Merged).

In every case the ticket returns to its human assignee, and — where
configured — a Slack notification is posted so the human knows a PR is
waiting or a task needs their attention.

## What bear-metal is *not*

- **Not a webhook consumer.** It polls Linear and GitHub on a fixed cadence.
  There is no webhook endpoint to expose.
- **Not a CI system.** It reads CI status from GitHub but does not run or
  gate merges itself.
- **Not language-specific.** It ships language-agnostic. Toolchains (Go,
  Rust, Python, pnpm, …) are installed via the
  [worker environment builder](../README.md#worker-environment-builder).
- **Not a merge bot.** Bear-metal opens PRs; humans (or their existing merge
  automation) merge them.
