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

1. **Find work.** Query Linear for tickets currently *delegated* to the
   bear-metal app actor (see below), plus the tickets bear-metal is already
   tracking.
2. **Reconcile state.** For each tracked ticket, check the Linear status and
   the PRs bear-metal has already opened for it (merged, closed, review
   comments, failing checks, merge conflicts, human commits on the branch).
3. **Decide.** Based on the ticket status and PR signals, decide whether to:
   - dispatch a worker run,
   - keep waiting (for example while CI is still running),
   - park the ticket,
   - hand the ticket back to the human, or
   - release it as completed.
4. **Dispatch.** If a worker run is warranted and a concurrency slot is free
   (`WORKER_CONCURRENCY`, default 5), start a worker for that ticket.

The scheduler never runs the coding agent itself — it only decides *when* a
worker should run and *why*. Every code change happens inside a worker.

## Delegation, not assignment

Bear-metal picks up tickets that are **delegated** to its Linear app actor,
not tickets that are merely assigned to it. In Linear, a human opens a
ticket, chooses **Delegate**, and selects bear-metal. The original assignee
stays on the ticket; bear-metal works it on their behalf.

If the human removes the delegation, the scheduler *parks* the ticket on the
next tick: it keeps its slot but no new work is dispatched. When the ticket
is delegated back, bear-metal resumes and dispatches a new run.

## A worker run

When the scheduler dispatches a worker, bear-metal:

1. **Customizes the task.** Calls the deployment's `customizeTask` hook from
   the [configuration module](../README.md#configuration-module). The hook
   selects the LLM provider and model (Anthropic, OpenAI, Google, or Amazon
   Bedrock), returns a `buildWorkspace` function, and may add a system-prompt
   suffix and duration/token limits.
2. **Builds the workspace.** Creates a fresh per-run directory under
   `BEAR_METAL_WORKSPACE_DIR/<ticket ID>/` (default base
   `~/.bear-metal/workspace`) with an `agent/` working directory, and calls
   `buildWorkspace` with a ten-minute abort signal. The builder is responsible for cloning the
   target repositories. The workspace is removed after the run.
3. **Runs the coding agent.** The agent works inside the workspace with the
   ticket description, any prior PR review context, and the repository's own
   instructions. It reads files, runs commands, edits code, and commits. The
   run is bounded by the task limits (default 2h and 20M tokens).
4. **Opens or updates a PR.** The harness pushes the branch and opens a pull
   request. If a PR already exists for the ticket (a follow-up run addressing
   review comments, failing checks, or merge conflicts), it updates that PR
   instead of opening a new one.
5. **Heartbeats.** The worker emits a heartbeat every
   `TASK_HEARTBEAT_INTERVAL_MS` (default 30s). If a task goes silent for
   longer than `TASK_STALE_AFTER_MS` (default 5m), the scheduler reclaims it,
   up to `TASK_MAX_RECLAIMS` (default 3) times before abandoning it.

Each worker run counts as one iteration for the ticket. When a ticket reaches
`maxIterations` (default 50), bear-metal stops and hands it back.

## Reacting to review

Bear-metal treats the PR itself as the conversation with the human. On each
scheduler tick, for every PR it has opened, it looks at:

- **Merge / close state** — once every PR is merged or closed, the ticket is
  released.
- **Unresolved review comments** — new actionable review threads or PR
  comments trigger a follow-up run.
- **Failing checks** — CI failures trigger a follow-up run. Deployments can
  narrow this with the `shouldRetryCi` hook.
- **Merge conflicts** — trigger a run to rebase and resolve them.
- **Human commits on the branch** — bear-metal steps aside and hands the
  ticket back, to avoid two actors editing the same PR.

The follow-up run receives the ticket context plus the PR signals (review
threads, failing checks, conflict state) so it can address them directly.

## Handing back

Bear-metal returns a ticket to its human assignee when:

- The PR was merged.
- A human pushed commits to the PR branch (human took over).
- The ticket reached `maxIterations`.
- The worker decided it needs human input and handed the ticket back with a
  comment.

When the Linear ticket moves to a terminal state (Done, Canceled, or
Merged), bear-metal stops tracking it.

If Slack is configured, bear-metal notifies the assignee when a PR is ready
(after CI settles), when it needs input, or when it hits the iteration limit.

## Slack threads

When the optional Slack app is configured with a signing secret, bear-metal
also listens on a Slack Events endpoint. Mentioning bear-metal in a channel
thread, or sending it a DM, lets it answer questions, run research tasks, or
create a Linear ticket — either delegated to bear-metal or just assigned to
the requester. See the [Slack guide](../README.md#slack) for details.

## What bear-metal is *not*

- **Not a Linear or GitHub webhook consumer.** It polls Linear and GitHub on
  a fixed cadence. The only inbound endpoint is the optional Slack Events
  endpoint.
- **Not a CI system.** It reads CI status from GitHub but does not run or
  gate merges itself.
- **Not language-specific.** The base image ships without project
  toolchains; add them in a
  [custom runtime image](../README.md#custom-runtime-image).
- **Not a merge bot.** Bear-metal opens PRs; humans (or their existing merge
  automation) merge them.
