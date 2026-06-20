import { randomUUID } from "node:crypto";
import PQueue from "p-queue";

import type {
  Logger,
  PullRequestRef,
  PullRequestStatus,
  RunTrigger,
  Ticket,
  TicketContext,
  WorkOutcome,
} from "../shared/index.js";

import type { SlackIntegration } from "../shared/index.js";

import type { DbClient, TaskSlot } from "../db/client.js";

type TicketPhase = "active" | "parked";

const TERMINAL_STATE_TYPES = ["completed", "canceled"];
const TERMINAL_STATE_NAMES = ["Merged"];



interface DispatchItem {
  context: TicketContext;
  trigger: RunTrigger;
}

export interface LinearSource {
  getAgentId(): Promise<string>;
  findDelegatedTickets(agentId: string): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket>;
  /** Relinquish the agent's delegation so the ticket returns to its human assignee. */
  handBack(ticketId: string): Promise<void>;
  /** Post a comment on the ticket and then relinquish delegation. */
  commentAndHandBack(ticketId: string, body: string): Promise<void>;
  getUserEmail(userId: string): Promise<string | null>;
  /** Returns open GitHub PR refs attached to the ticket, parsed from Linear attachments. */
  getPullRequestRefs(ticketId: string): Promise<PullRequestRef[]>;
}

export interface GitHubSource {
  /** Look up a known PR by ref for its merge/close state and work signals. */
  getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus>;
  /** Post an issue-style comment on the PR — used to explain a human-takeover handoff. */
  leaveComment(ref: PullRequestRef, body: string): Promise<void>;
  /** True if the PR already has an issue comment containing `marker`. Used for idempotent one-shot comments. */
  hasIssueCommentWithMarker(ref: PullRequestRef, marker: string): Promise<boolean>;
}

// Hidden marker keeps the takeover comment idempotent: if a retry sees the marker already present
// on the PR, we skip re-posting so transient failures don't produce duplicate handoff comments.
const HUMAN_TAKEOVER_MARKER = "<!-- bear-metal:human-takeover -->";
const HUMAN_TAKEOVER_PR_COMMENT =
  HUMAN_TAKEOVER_MARKER +
  "\n🐻 Detected a human commit on this branch after bear-metal's last push. " +
  "Stepping aside so I don't conflict with your work. Re-delegate the Linear ticket if you'd like me to pick it back up.";

const HUMAN_TAKEOVER_LINEAR_COMMENT =
  "Detected a commit on the PR branch made after bear-metal's last push, indicating a human takeover. " +
  "Releasing this ticket to avoid stepping on the human's work. Re-delegate to bear-metal if you'd like me to resume.";

export interface TicketHandler {
  handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome>;
}

export interface SchedulerDeps {
  logger: Logger;
  linear: LinearSource;
  github: GitHubSource;
  db: DbClient;
  handler: TicketHandler;
  concurrency: number;
  pollIntervalMs: number;
  /** A task whose owning worker hasn't heartbeat within this many ms is considered crashed/hung. */
  taskStaleAfterMs: number;
  /** Cap on how many times a single row can be recovered before the manager abandons it. */
  taskMaxReclaims: number;
  slack?: SlackIntegration;
  maxIterations: number;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly queue: PQueue;
  /** Tickets with a handler invocation in flight — guards against double-dispatch. */
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.queue = new PQueue({ concurrency: deps.concurrency });
  }

  start(): void {
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.deps.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.queue.onIdle();
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.deps.logger.error({ err }, "poll tick failed");
    }
  }

  async tick(): Promise<void> {
    const { db, linear, github, handler, logger, concurrency } = this.deps;
    const agentId = await linear.getAgentId();

    try {
      const recovered = await db.reclaimStaleTasks({
        staleAfterMs: this.deps.taskStaleAfterMs,
        maxReclaims: this.deps.taskMaxReclaims,
      });
      for (const r of recovered) {
        logger.warn(
          {
            taskId: r.task.id,
            ticketId: r.task.ticketId,
            action: r.action,
            reclaimCount: r.task.reclaimCount,
            reason: r.reason,
          },
          "recovered stale in-flight task",
        );
        void db.upsertRunCrashed(r.task.id, r.reason);
        void db.recordEvent({
          id: randomUUID(),
          ticketId: r.task.ticketId,
          runId: r.task.id,
          workerId: r.previousWorkerId,
          source: "manager",
          type: "worker_crashed",
          summary: r.reason,
          payloadJson: null,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error({ err }, "stale task recovery failed");
    }

    const tracked = await db.listTracked();
    const inFlight = tracked.filter((s) => s.latestTask.resultStatus === null).length;
    logger.debug({ tracked: tracked.length, inFlight }, "poll tick started");

    const refreshed = await refreshTrackedTickets(db, linear, github, agentId, logger, this.deps.slack);
    const admitted = await admitNewTickets(
      db,
      linear,
      agentId,
      freeSlots(concurrency, inFlight),
      logger,
    );

    const toDispatch = [...refreshed, ...admitted];
    const eligible = await enforceIterationLimit(toDispatch, db, linear, logger, this.deps.maxIterations);
    await dispatchTickets(eligible, handler, this.queue, this.inFlight, logger);

    const trackedAfter = await db.listTracked();
    logger.debug(
      {
        tracked: trackedAfter.length,
        inFlight: trackedAfter.filter((s) => s.latestTask.resultStatus === null).length,
        admitted: admitted.length,
        dispatched: eligible.length,
      },
      "poll tick complete",
    );
  }
}

export function freeSlots(concurrency: number, activeCount: number): number {
  return Math.max(0, concurrency - activeCount);
}

/**
 * Pick which candidate tickets to admit: not already tracked, sorted by Linear
 * priority (Urgent → High → Medium → Low → No Priority), capped at free slots.
 *
 * Linear encodes priority as 1=Urgent, 2=High, 3=Medium, 4=Low, 0=No priority, so a
 * naive ascending sort would put "No priority" first. We remap 0 to +Infinity so it
 * sinks to the bottom. The sort is stable, preserving Linear's returned order within
 * a single priority bucket.
 */
export function selectAdmissions(
  candidates: Ticket[],
  isTracked: (id: string) => boolean,
  free: number,
): Ticket[] {
  if (free <= 0) {
    return [];
  }
  return candidates
    .filter((ticket) => !isTracked(ticket.id))
    .slice()
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, free);
}

function priorityRank(priority: number): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

interface TicketDecision {
  /** Release the ticket's SQL slot. */
  remove: boolean;
  /** PR was merged (subset of `remove`); the ticket should be handed back to its human assignee. */
  merged: boolean;
  context: TicketContext;
  /** Hand the ticket to the worker this tick. */
  dispatch: boolean;
  /** Whether the ticket is currently the manager's ("active") or parked with someone else. */
  phase: TicketPhase;
  /** Why this run is dispatched; carried into the handler. Unused when `dispatch` is false. */
  trigger: RunTrigger;
  /** When set, a human pushed a commit after bear-metal on these open PRs — hand back with comments. */
  humanTookOverPrs?: PullRequestRef[];
  /** Linear already moved the ticket to a terminal state (Done/Canceled) — treat as completed, skip handBack. */
  terminated?: boolean;
}

/**
 * Refresh one tracked ticket and decide what to do with it.
 * - Terminal Linear tickets release their SQL slot, even if no PR is known.
 * - Not delegated to the manager -> parked: held in its slot and not dispatched.
 * - Delegated to the manager, just back from parked -> resume: re-dispatched.
 * - Known PR -> query GitHub by the PR ref returned by a previous worker task.
 * - No PR -> never discover or guess; dispatch only on the resume edge.
 */
async function evaluateTicket(
  ticket: Ticket,
  knownPrs: PullRequestRef[],
  prevPhase: TicketPhase,
  agentId: string,
  github: GitHubSource,
  db: DbClient,
  logger: Logger,
): Promise<TicketDecision> {
  if (isTerminalLinearTicket(ticket)) {
    logger.debug(
      { ticket: ticket.identifier, statusName: ticket.status.name, statusType: ticket.status.type },
      "linear ticket is terminal; releasing slot",
    );
    return { remove: true, merged: false, terminated: true, context: { ticket, prs: knownPrs }, dispatch: false, phase: "active", trigger: "new" };
  }

  if (ticket.delegate?.id !== agentId) {
    logger.debug(
      { ticket: ticket.identifier, delegate: ticket.delegate?.id ?? null },
      "ticket not delegated to manager; parking",
    );

    return { remove: false, merged: false, context: { ticket, prs: knownPrs }, dispatch: false, phase: "parked", trigger: "new" };
  }

  const resuming = prevPhase === "parked";
  if (resuming) {
    logger.info({ ticket: ticket.identifier }, "ticket re-delegated to manager; resuming");
  }

  if (knownPrs.length === 0) {
    return { remove: false, merged: false, context: { ticket, prs: [] }, dispatch: resuming, phase: "active", trigger: "delegated_back" };
  }

  // Filter out issue comments already handled by the worker before computing hasActionableIssueComments.
  // Without this the manager loops: GitHub still shows the comments even after the worker marks them
  // complete in our DB, causing hasActionableIssueComments to stay true every tick forever.
  const statuses = await Promise.all(
    knownPrs.map(async (pr) => {
      const raw = await github.getPullRequestStatus(pr);
      const completedIds = await db.getCompleted(pr);
      const unhandled = raw.context.issueComments.filter((c) => !completedIds.has(c.id));
      return { ...raw, hasActionableIssueComments: unhandled.length > 0 };
    }),
  );

  if (statuses.every((s) => s.pr.merged || s.pr.state === "closed")) {
    const anyMerged = statuses.some((s) => s.pr.merged);
    logger.debug(
      { ticket: ticket.identifier, count: statuses.length, anyMerged },
      "all pull requests resolved; releasing ticket",
    );
    return { remove: true, merged: anyMerged, context: { ticket, prs: knownPrs }, dispatch: false, phase: "active", trigger: "delegated_back" };
  }

  const takenOver = statuses.filter((s) => s.humanTookOver && !s.pr.merged && s.pr.state !== "closed");
  if (takenOver.length > 0) {
    logger.warn(
      { ticket: ticket.identifier, prs: takenOver.map((s) => s.pr.number) },
      "human takeover detected on PR head branch; handing ticket back",
    );
    return {
      remove: true,
      merged: false,
      context: { ticket, prs: knownPrs },
      dispatch: false,
      phase: "active",
      trigger: "delegated_back",
      humanTookOverPrs: takenOver.map((s) => ({ owner: s.pr.owner, repo: s.pr.repo, number: s.pr.number })),
    };
  }

  const testsFailed = statuses.some((s) => s.testsFailed);
  const hasActionableUnresolvedComments = statuses.some((s) => s.hasActionableUnresolvedComments);
  const hasActionableIssueComments = statuses.some((s) => s.hasActionableIssueComments);
  const hasMergeConflicts = statuses.some((s) => s.hasMergeConflicts);
  try {
    for (const status of statuses.filter((s) => !s.pr.merged && s.pr.state !== "closed")) {
      const pr = status.pr;
      const prDbId = `${pr.owner}/${pr.repo}#${pr.number}`;
      await db.upsertPullRequest(prDbId, ticket.id, {
        number: pr.number,
        title: pr.title,
        headRef: pr.headRef,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        url: pr.url,
        lastRunId: null,
        reviewThreadsJson: JSON.stringify(status.context.reviewThreads.map((t) => ({
          id: t.id,
          path: t.path,
          line: t.line,
          isResolved: t.isResolved,
          commentsJson: JSON.stringify(t.comments),
        }))),
      });
    }
  } catch (err) {
    logger.warn({ err, ticket: ticket.identifier }, "best-effort dashboard observation failed");
  }

  const needsWork = resuming || testsFailed || hasMergeConflicts || hasActionableUnresolvedComments || hasActionableIssueComments;
  if (needsWork) {
    logger.debug(
      { ticket: ticket.identifier, count: statuses.length, resuming, hasMergeConflicts },
      "pull requests need work; re-dispatching",
    );
  }
  // CI failure takes priority over merge conflicts, which take priority over review/resume.
  const trigger: RunTrigger = testsFailed
    ? "ci_failure"
    : hasMergeConflicts
      ? "merge_conflict"
      : "delegated_back";
  return { remove: false, merged: false, context: { ticket, prs: knownPrs }, dispatch: needsWork, phase: "active", trigger };
}

async function refreshTrackedTickets(
  db: DbClient,
  linear: LinearSource,
  github: GitHubSource,
  agentId: string,
  logger: Logger,
  slack?: SlackIntegration,
): Promise<DispatchItem[]> {
  const toDispatch: DispatchItem[] = [];
  for (const slot of await db.listTracked()) {
    try {
      const ticket = await linear.getTicket(slot.ticketId!);
      // A "pending" worker result means the worker stopped without finishing the ticket. The worker
      // returns "pending" both when it hands the ticket back to its human owner (via
      // commentAndHandBack — drops delegation) and when it pauses mid-run while still owning the
      // ticket (e.g. respond_to_pr_review). Distinguish the two via the live Linear delegation:
      // if the manager is no longer the delegate, the worker handed it back and the slot must be
      // released; otherwise fall through to normal evaluation so PR review / parking still work.
      if (slot.latestTask.resultStatus === "pending" && ticket.delegate?.id !== agentId) {
        logger.info({ ticket: ticket.identifier }, "worker handed ticket back; removed from tracking");
        await db.setSlotStatus(slot.ticketId!, "released");
        if (slack) {
          try {
            const recipientEmail = ticket.assignee
              ? (await linear.getUserEmail(ticket.assignee.id)) ?? undefined
              : undefined;
            await slack.notifyNeedsInput({
              ticketId: ticket.identifier,
              ticketUrl: ticket.url,
              title: ticket.title,
              recipientEmail,
            });
          } catch (err) {
            logger.warn({ err, ticketId: ticket.id }, "failed to send needs_input Slack notification");
          }
        }
        continue;
      }
      const knownPrs = knownPrsForSlot(slot);
      const decision = await evaluateTicket(ticket, knownPrs, slot.slotStatus, agentId, github, db, logger);
      if (decision.remove) {
        if (decision.terminated) {
          logger.info({ ticket: ticket.identifier, linearStatus: ticket.status.name }, "linear ticket terminal; releasing slot as completed");
          await db.setTicketStatus(ticket.id, "completed");
          void db.recordEvent({
            id: randomUUID(),
            ticketId: ticket.id,
            runId: null,
            workerId: null,
            source: "manager",
            type: "ticket_completed",
            summary: `completed ${ticket.identifier} (Linear: ${ticket.status.name})`,
            payloadJson: null,
            createdAt: new Date().toISOString(),
          });
        } else if (decision.merged) {
          await linear.handBack(ticket.id);
          logger.info({ ticket: ticket.identifier }, "handed ticket back to assignee after merge");
          await db.setTicketStatus(ticket.id, "completed");
          void db.recordEvent({
            id: randomUUID(),
            ticketId: ticket.id,
            runId: null,
            workerId: null,
            source: "manager",
            type: "ticket_completed",
            summary: `completed ${ticket.identifier}`,
            payloadJson: null,
            createdAt: new Date().toISOString(),
          });
        } else if (decision.humanTookOverPrs && decision.humanTookOverPrs.length > 0) {
          for (const prRef of decision.humanTookOverPrs) {
            const alreadyCommented = await github.hasIssueCommentWithMarker(prRef, HUMAN_TAKEOVER_MARKER);
            if (alreadyCommented) {
              logger.debug(
                { ticket: ticket.identifier, pr: prRef.number },
                "human-takeover comment already present; skipping",
              );
              continue;
            }
            await github.leaveComment(prRef, HUMAN_TAKEOVER_PR_COMMENT);
          }
          await linear.commentAndHandBack(ticket.id, HUMAN_TAKEOVER_LINEAR_COMMENT);
          logger.info({ ticket: ticket.identifier }, "handed ticket back after human takeover");
          void db.setTicketStatus(ticket.id, "waiting_for_human");
          void db.recordEvent({
            id: randomUUID(),
            ticketId: ticket.id,
            runId: null,
            workerId: null,
            source: "manager",
            type: "delegated_back",
            summary: "human takeover detected on PR branch",
            payloadJson: null,
            createdAt: new Date().toISOString(),
          });
        } else if (!decision.merged && decision.context.prs.length > 0) {
          void db.setTicketStatus(ticket.id, "waiting_for_human");
        }
        await db.setSlotStatus(slot.ticketId!, "released");
        continue;
      }

      if (slot.slotStatus !== decision.phase) {
        await db.setSlotStatus(slot.ticketId!, decision.phase);
      }
      if (decision.dispatch) {
        if (slot.latestTask.resultStatus === null) {
          logger.debug({ ticket: ticket.identifier }, "ticket already has active SQL task; skipping dispatch");
        } else {
          void db.setTicketStatus(ticket.id, "in_progress");
          toDispatch.push({ context: decision.context, trigger: decision.trigger });
          if (decision.trigger !== "ci_failure") {
            void db.recordEvent({
              id: randomUUID(),
              ticketId: ticket.id,
              runId: null,
              workerId: null,
              source: "manager",
              type: "delegated_back",
              summary: decision.trigger === "merge_conflict"
                ? "re-dispatched: merge conflicts on PR head"
                : "re-dispatched: unresolved review or resumed",
              payloadJson: null,
              createdAt: new Date().toISOString(),
            });
          }
        }
      } else if (decision.phase === "active") {
        const preTransition = await db.readTicketStatus(ticket.id);
        logger.debug(
          { ticket: ticket.identifier, dbStatus: preTransition?.status, dbNotify: preTransition?.notify },
          "ticket_statuses before tryTransitionToWaitingForHuman",
        );
        const shouldDm = await db.tryTransitionToWaitingForHuman(ticket.id);
        logger.debug(
          { ticket: ticket.identifier, shouldDm, hasSlack: !!slack, prCount: decision.context.prs.length },
          "tryTransitionToWaitingForHuman result",
        );
        if (shouldDm && slack && decision.context.prs.length > 0) {
          try {
            const recipientEmail = ticket.assignee
              ? await linear.getUserEmail(ticket.assignee.id)
              : null;
            const perPr = await Promise.all(
              decision.context.prs.map(async (prRef) => {
                const prDbId = `${prRef.owner}/${prRef.repo}#${prRef.number}`;
                const [prStatus, prNotifiedAt] = await Promise.all([
                  github.getPullRequestStatus(prRef),
                  db.getPrNotifiedAt(prDbId),
                ]);
                return {
                  prRef,
                  prDbId,
                  url: prStatus.pr.url,
                  kind: (prNotifiedAt == null ? "opened" : "updated") as "opened" | "updated",
                };
              }),
            );
            const groups: Array<"opened" | "updated"> = ["opened", "updated"];
            for (const kind of groups) {
              const items = perPr.filter((p) => p.kind === kind);
              if (items.length === 0) continue;
              await slack.notifyPullRequest({
                kind,
                prs: items.map((p) => ({ pr: p.prRef, url: p.url })),
                title: ticket.title,
                ticketId: ticket.identifier,
                ticketUrl: ticket.url,
                recipientEmail: recipientEmail ?? undefined,
              });
              for (const p of items) {
                try {
                  await db.markPrNotified(p.prDbId);
                } catch (markErr) {
                  logger.warn(
                    { err: markErr, ticketId: ticket.id, prDbId: p.prDbId },
                    "failed to mark PR as notified after Slack send",
                  );
                }
                void db.recordEvent({
                  id: randomUUID(),
                  ticketId: ticket.id,
                  runId: slot.latestTask.id,
                  workerId: null,
                  source: "manager",
                  type: "user_notified",
                  summary: `user notified via Slack — PR #${p.prRef.number} in ${p.prRef.repo}`,
                  payloadJson: recipientEmail ? JSON.stringify({ recipientEmail }) : null,
                  createdAt: new Date().toISOString(),
                });
              }
            }
          } catch (err) {
            logger.warn({ err, ticketId: ticket.id }, "failed to send waiting_for_human Slack DM");
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, ticketId: slot.ticketId, taskId: slot.latestTask.id },
        "tracked slot refresh failed; leaving slot tracked",
      );
    }
  }
  return toDispatch;
}

async function admitNewTickets(
  db: DbClient,
  linear: LinearSource,
  agentId: string,
  free: number,
  logger: Logger,
): Promise<DispatchItem[]> {
  if (free <= 0) {
    return [];
  }
  const [candidates, tracked] = await Promise.all([linear.findDelegatedTickets(agentId), db.listTracked()]);
  const trackedTicketIds = new Set(tracked.map((slot) => slot.ticketId));
  const admitted = selectAdmissions(candidates, (id) => trackedTicketIds.has(id), free);
  const contexts: DispatchItem[] = [];
  for (const ticket of admitted) {
    const prs = await linear.getPullRequestRefs(ticket.id).catch((err) => {
      logger.warn({ err, ticket: ticket.identifier }, "failed to fetch PR refs from Linear; admitting with empty PR list");
      return [];
    });
    logger.info({ ticket: ticket.identifier, prCount: prs.length }, "picked up ticket");
    const context: TicketContext = { ticket, prs };
    await db.upsertTicketDiscovered({
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      url: ticket.url,
      branchName: ticket.branchName,
      linearStatusName: ticket.status.name,
      linearStatusType: ticket.status.type,
      labels: ticket.labels,
    });
    contexts.push({ context, trigger: "new" });
  }
  return contexts;
}

async function dispatchTickets(
  items: DispatchItem[],
  handler: TicketHandler,
  queue: PQueue,
  inFlight: Set<string>,
  logger: Logger,
): Promise<void> {
  const work: Array<Promise<void>> = [];
  for (const { context, trigger } of items) {
    const id = context.ticket.identifier;
    if (inFlight.has(id)) {
      continue;
    }
    inFlight.add(id);
    work.push(queue.add(() => runHandler(context, trigger, handler, inFlight, logger)));
  }
  await Promise.all(work);
}

async function runHandler(
  context: TicketContext,
  trigger: RunTrigger,
  handler: TicketHandler,
  inFlight: Set<string>,
  logger: Logger,
): Promise<void> {
  const id = context.ticket.identifier;
  try {
    const outcome = await handler.handle(context, trigger);
    logger.debug(
      { ticket: context.ticket.identifier, taskId: outcome.taskId ?? null, status: outcome.status },
      "ticket handling queued",
    );
  } catch (err) {
    logger.error({ err, ticket: context.ticket.identifier }, "ticket handling failed");
  } finally {
    inFlight.delete(id);
  }
}

async function enforceIterationLimit(
  items: DispatchItem[],
  db: DbClient,
  linear: LinearSource,
  logger: Logger,
  maxIterations: number,
): Promise<DispatchItem[]> {
  const eligible: DispatchItem[] = [];
  for (const item of items) {
    const ctx = item.context;
    try {
      const count = await db.getIterationCount(ctx.ticket.id);
      if (count >= maxIterations) {
        logger.warn(
          { ticket: ctx.ticket.identifier, count },
          "iteration limit reached; handing back",
        );
        await linear.commentAndHandBack(
          ctx.ticket.id,
          `Reached the maximum iteration limit of ${maxIterations}. No further automated work will be attempted. Please review the history and re-delegate if you'd like to try again.`,
        );
        await db.setSlotStatus(ctx.ticket.id, "released");
      } else {
        eligible.push(item);
      }
    } catch (err) {
      logger.error(
        { err, ticket: ctx.ticket.identifier },
        "iteration limit check failed; skipping dispatch",
      );
    }
  }
  return eligible;
}

/**
 * Resolve the set of PRs the manager currently associates with a tracked slot.
 * Prefers the worker's returned `result.prs` (authoritative once a task is done);
 * falls back to the task input for in-flight tasks.
 */
function knownPrsForSlot(slot: TaskSlot): PullRequestRef[] {
  const task = slot.latestTask;
  const prs = task.result?.prs ?? task.input?.prs ?? [];
  if (task.resultStatus === "done" && prs.length === 0) {
    // A completed-done task with no PRs is an anomalous worker result.
    // Throw so refreshTrackedTickets' catch block logs and skips this slot
    // instead of silently treating it as a no-PR ticket.
    throw new Error(
      `Task ${task.id} for ticket ${slot.ticketId} completed with status "done" but produced no pull requests`,
    );
  }
  return prs;
}

function isTerminalLinearTicket(ticket: Ticket): boolean {
  return TERMINAL_STATE_TYPES.includes(ticket.status.type) || TERMINAL_STATE_NAMES.includes(ticket.status.name);
}

