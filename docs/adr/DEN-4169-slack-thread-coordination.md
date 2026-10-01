# DEN-4169: Coordinate Slack requests per thread

Status: Accepted

## Context

Slack can deliver mentions and message events for the same message, retry events, and deliver new replies while a coordinator is running. Concurrent coordinator runs on one thread could duplicate tickets or post an answer after a correction.

## Decision

The single manager process records Slack message references durably before acknowledging events. It serializes coordinator runs by workspace, channel, and root thread timestamp. Distinct threads may run concurrently. The coordinator reads unprocessed messages and compact task summaries, then uses tools for full Slack messages and task details. Coding and research work uses the existing `tasks` table; thread identity and processed-message references have separate tables. Research results return to the same thread queue before a reply is posted.
Message processing and completed-result review use separate coordinator prompts and tool sets. The result review reads the stored task and current thread, then explicitly approves or cancels the result. Only a persisted approval permits the reply, including after a restart; a new message is processed before either decision can post the answer.

External Linear creation and Slack posting are never retried automatically after an uncertain outcome. A task is persisted before the external call and records a failed or posting state so event retries do not duplicate it.
For coding requests, the Slack task becomes the normal ticket task: store the Linear ticket ID on that row before delegating the ticket. The scheduler can then discover and dispatch the ticket using that same row. A ticket row without a dispatch state does not occupy a scheduler slot.

## Consequences

This design relies on one manager process owning the in-memory queue. Restart recovery uses the durable inbox and task states; it does not crawl Slack for events that were never recorded. SQLite's finite busy timeout keeps lock contention visible. Multiple manager processes would require a distributed per-thread coordinator lock or a different queue owner.
