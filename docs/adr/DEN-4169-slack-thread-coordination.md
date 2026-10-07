# DEN-4169: Coordinate Slack requests per thread

Status: Accepted

## Context

Slack can deliver mentions and message events for the same message, retry events, and deliver new replies while a coordinator is running. Concurrent coordinator runs on one thread could duplicate tickets or post an answer after a correction.

## Decision

The single manager process records Slack message references durably before acknowledging events. It serializes coordinator runs by workspace, channel, and root thread timestamp. Distinct threads may run concurrently. The coordinator reads unprocessed messages and compact task summaries, then uses tools for full Slack messages and task details. Coding and research work uses the existing `tasks` table; thread identity and processed-message references have separate tables. Research results return to the same thread queue before a reply is posted.
Coordinator runs share a source checkout prepared by the configured workspace builder. A complete generation is reused for up to 24 hours, then replaced; active runs keep the previous generation until they finish. Pi receives root `AGENTS.md` and read-only file tools. This gives coordination repository context without cloning for every Slack message. The agent has no shell or file-write tools for this checkout; OS-level protection requires a separate user or read-only mount if stronger isolation is needed.
Message processing and completed-result review use separate coordinator prompts and tool sets. The result review reads the stored task and current thread, then explicitly approves or cancels the result. Only a persisted approval permits the reply, including after a restart; a new message is processed before either decision can post the answer.
If a new message arrives during result review, the active agent session is aborted with a clean `deferred` run stop reason. The same thread loop processes the message immediately and then retries eligible result review. Research answer submission does not await that loop; its saved result is the durable handoff. The periodic poll is only a recovery path.
Each task tool posts its own acknowledgment after successful task creation. The source Slack user ID is stored on the task so an approved research answer can mention the requester after a restart. The answer uses Slack's Markdown block while the mention and quoted question use Slack mrkdwn.

External Linear creation and Slack posting are never retried automatically after an uncertain outcome. A task is persisted before the external call and records a failed or posting state so event retries do not duplicate it.
For coding requests, the Slack task becomes the normal ticket task: store the Linear ticket ID on that row before delegating the ticket. The scheduler can then discover and dispatch the ticket using that same row. A ticket row without a dispatch state does not occupy a scheduler slot.
Coding ticket creation resolves the source Slack user's email to exactly one Linear user, assigns that user, then delegates to Bear Metal. Replacing a task cancels its prior Linear ticket and removes delegation before creating the new ticket; the superseded task does not post a cancellation reply. Recovery closes an interrupted research run as crashed while requeuing the Slack task.

## Consequences

This design relies on one manager process owning the in-memory queue. Restart recovery uses the durable inbox and task states; it does not crawl Slack for events that were never recorded. SQLite's finite busy timeout keeps lock contention visible. Multiple manager processes would require a distributed per-thread coordinator lock or a different queue owner.

## Execution visibility and retention

The local Slack test showed that processed-message and task rows cannot explain a coordinator decision when no task is created. Each coordinator invocation therefore gets its own durable run row; research reuses its task row, and coding retains its existing run row. All three write bounded, redacted prompts, assistant text, provider-visible thinking, and completed tool calls to an append-only trace table. Provider-hidden reasoning and opaque thinking signatures are not recorded. The dashboard lists these runs and reads their execution trace.

Detailed trace records expire after 14 days by default, with `traceRetentionDays` in the trusted config module as a positive-integer override. Cleanup runs at manager startup and hourly. It also clears the older coding tool-call JSON and agent-start prompt payloads after the same period, while leaving task/run status and other operational metadata intact. Container-local transcript files remain temporary because restart diagnostics require durable history.

For local Slack testing, `BEAR_METAL_RUN_MODE=slack_only` disables the Linear scheduler and coding worker while keeping the Slack coordinator and research worker active. Coordinator tools may still create or cancel Linear tickets when a Slack request calls for that action.
