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

import type { DashboardReporter } from "./dashboardReporter.js";
import type { TaskQueue, TaskSlot } from "./tasks.js";

type TicketPhase = "active" | "parked";

const TERMINAL_STATE_TYPES = ["completed", "canceled"];
const TERMINAL_STATE_NAMES = ["Merged"];

const MAX_ITERATIONS = 20;

/** A ticket queued for dispatch this tick, carrying the reason its run was triggered. */
interface DispatchItem {
  context: TicketContext;
  trigger: RunTrigger;
}

/** The Linear capabilities the scheduler needs (subset of LinearIntegration). */
export interface LinearSource {
  findDelegatedTickets(agentId: string): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket>;
  /** Relinquish the agent's delegation so the ticket returns to its human assignee. */
  handBack(ticketId: string): Promise<void>;
  /** Post a comment on the ticket and then relinquish delegation. */
  commentAndHandBack(ticketId: string, body: string): Promise<void>;
}

/** The GitHub capabilities the scheduler needs (subset of GitHubIntegration). */
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
  "\n\ud83d\udc3b Detected a human commit on this branch after bear-metal's last push. " +
  "Stepping aside so I don't conflict with your work. Re-delegate the Linear ticket if you'd like me to pick it back up.";

const HUMAN_TAKEOVER_LINEAR_COMMENT =
  "Detected a commit on the PR branch made after bear-metal's last push, indicating a human takeover. " +
  "Releasing this ticket to avoid stepping on the human's work. Re-delegate to bear-metal if you'd like me to resume.";

/** The decision capability the scheduler needs (satisfied by ManagerTicketHandler). */
export interface TicketHandler {
  handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome>;
}

export interface SchedulerDeps {
  logger: Logger;
  linear: LinearSource;
  github: GitHubSource;
  tasks: TaskQueue;
  handler: TicketHandler;
  /** Linear user id of the agent the manager runs as; it works tickets delegated to this id. */
  agentId: string;
  concurrency: number;
  pollIntervalMs: number;
  reporter?: DashboardReporter;
  /** A task whose owning worker hasn't heartbeat within this many ms is considered crashed/hung. */
  taskStaleAfterMs?: number;
  /** Cap on how many times a single row can be recovered before the manager abandons it. */
  taskMaxReclaims?: number;
}

const DEFAULT_TASK_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_TASK_MAX_RECLAIMS = 3;

// ---------------------------------------------------------------------------
// Scheduler — owns the timer, queue, and in-flight guard; composes the steps.
// ---------------------------------------------------------------------------

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
      // One bad fetch must not kill the daemon; the next tick retries.
      this.deps.logger.error({ err }, "poll tick failed");
    }
  }

  /**
   * One poll cycle: refresh tracked SQL slots, admit newly delegated tickets into
   * free SQL slots, then enqueue one worker task per eligible dispatch.
   */
  async tick(): Promise<void> {
    const { tasks, linear, github, handler, logger, agentId, concurrency, reporter } = this.deps;

    // Recover any tasks owned by a dead/hung worker before reading the tracked set, so the
    // subsequent in-flight count and dispatch decisions see the fresh state.
    try {
      const recovered = await tasks.reclaimStaleTasks({
        staleAfterMs: this.deps.taskStaleAfterMs ?? DEFAULT_TASK_STALE_AFTER_MS,
        maxReclaims: this.deps.taskMaxReclaims ?? DEFAULT_TASK_MAX_RECLAIMS,
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
        void reporter?.runCrashedById(
          r.task.id,
          r.task.input.ticketIssueId,
          r.previousWorkerId,
          r.task.attemptNumber,
          r.task.input.trigger,
          r.reason,
        );
      }
    } catch (err) {
      // One bad recovery sweep must not kill the tick; the next tick retries.
      logger.error({ err }, "stale task recovery failed");
    }

    const tracked = await tasks.listTracked();
    const inFlight = tracked.filter((s) => s.latestTask.resultStatus === null).length;
    logger.info({ tracked: tracked.length, inFlight }, "poll tick started");

    const refreshed = await refreshTrackedTickets(tasks, linear, github, agentId, logger, reporter);
    const admitted = await admitNewTickets(
      tasks,
      linear,
      agentId,
      freeSlots(concurrency, inFlight),
      logger,
      reporter,
    );

    const toDispatch = [...refreshed, ...admitted];
    const eligible = await enforceIterationLimit(toDispatch, tasks, linear, logger);
    await dispatchTickets(eligible, handler, this.queue, this.inFlight, logger);

    const trackedAfter = await tasks.listTracked();
    logger.info(
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Open worker slots given the concurrency cap and the current active count. */
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
  isTracked: (identifier: string) => boolean,
  free: number,
): Ticket[] {
  if (free <= 0) {
    return [];
  }
  return candidates
    .filter((ticket) => !isTracked(ticket.identifier))
    .slice()
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, free);
}

function priorityRank(priority: number): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority;
}

// ---------------------------------------------------------------------------
// Effectful steps (each one cycle stage)
// ---------------------------------------------------------------------------

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
  logger: Logger,
  reporter?: DashboardReporter,
): Promise<TicketDecision> {
  if (isTerminalLinearTicket(ticket)) {
    logger.info(
      { ticket: ticket.identifier, statusName: ticket.status.name, statusType: ticket.status.type },
      "linear ticket is terminal; releasing slot",
    );
    return { remove: true, merged: false, context: { ticket, prs: knownPrs }, dispatch: false, phase: "active", trigger: "new" };
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

  const statuses = await Promise.all(knownPrs.map((pr) => github.getPullRequestStatus(pr)));

  if (statuses.every((s) => s.pr.merged || s.pr.state === "closed")) {
    const anyMerged = statuses.some((s) => s.pr.merged);
    logger.info(
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
  // Report each open PR's current state (best-effort; never affects dispatch).
  void (async () => {
    try {
      for (const status of statuses.filter((s) => !s.pr.merged && s.pr.state !== "closed")) {
        await reporter?.recordPullRequestObservation(ticket, status.pr, status.context, null);
      }
      if (testsFailed) {
        await reporter?.ciFailed(ticket, "CI checks failed");
      } else {
        const firstPr = statuses[0]?.pr;
        if (firstPr) await reporter?.prOpened(ticket, firstPr);
      }
    } catch (err) {
      logger.warn({ err, ticket: ticket.identifier }, "best-effort dashboard observation failed");
    }
  })();

  const needsWork = resuming || testsFailed || hasActionableUnresolvedComments;
  if (needsWork) {
    logger.info(
      { ticket: ticket.identifier, count: statuses.length, resuming },
      "pull requests need work; re-dispatching",
    );
    if (!testsFailed) {
      void reporter?.delegatedBack(ticket, "Re-dispatched: unresolved review or resumed");
    }
  }
  const trigger: RunTrigger = testsFailed ? "ci_failure" : "delegated_back";
  return { remove: false, merged: false, context: { ticket, prs: knownPrs }, dispatch: needsWork, phase: "active", trigger };
}

/** Step 1 — refresh tracked SQL slots, release resolved slots, collect those needing dispatch. */
async function refreshTrackedTickets(
  tasks: TaskQueue,
  linear: LinearSource,
  github: GitHubSource,
  agentId: string,
  logger: Logger,
  reporter?: DashboardReporter,
): Promise<DispatchItem[]> {
  const toDispatch: DispatchItem[] = [];
  for (const slot of await tasks.listTracked()) {
    try {
      const ticket = await linear.getTicket(slot.ticketId);
      // A "pending" worker result means the worker stopped without finishing the ticket. The worker
      // returns "pending" both when it hands the ticket back to its human owner (via
      // commentAndHandBack — drops delegation) and when it pauses mid-run while still owning the
      // ticket (e.g. respond_to_pr_review). Distinguish the two via the live Linear delegation:
      // if the manager is no longer the delegate, the worker handed it back and the slot must be
      // released; otherwise fall through to normal evaluation so PR review / parking still work.
      if (slot.latestTask.resultStatus === "pending" && ticket.delegate?.id !== agentId) {
        logger.info(
          { ticket: ticket.identifier },
          "worker handed ticket back; removed from tracking",
        );
        await tasks.setSlotStatus(slot.ticketId, "released");
        continue;
      }
      const knownPrs = knownPrsForSlot(slot);
      const decision = await evaluateTicket(ticket, knownPrs, slot.slotStatus, agentId, github, logger, reporter);
      if (decision.remove) {
        if (decision.merged) {
          // PR merged — relinquish the agent's delegation so the ticket returns to its human assignee.
          // If this throws, leave the slot tracked so the next tick retries.
          await linear.handBack(ticket.id);
          logger.info({ ticket: ticket.identifier }, "handed ticket back to assignee after merge");
          void reporter?.ticketCompleted(ticket);
        } else if (decision.humanTookOverPrs && decision.humanTookOverPrs.length > 0) {
          // Human pushed a commit after bear-metal — leave a PR comment on each taken-over PR,
          // then post a Linear comment and relinquish delegation. If any call throws, leave the
          // slot tracked so the next tick retries cleanly. Each PR comment is gated by a hidden
          // marker so a retry after a partial failure does not produce duplicate comments on
          // PRs that already received the handoff.
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
          void reporter?.delegatedBack(ticket, "Human takeover detected on PR branch");
        }
        await tasks.setSlotStatus(slot.ticketId, "released");
        continue;
      }

      if (slot.slotStatus !== decision.phase) {
        await tasks.setSlotStatus(slot.ticketId, decision.phase);
      }
      // Delegated, tracked, no PR yet — it's being worked but has nothing to show. (Parked tickets stay quiet.)
      if (decision.phase === "active" && decision.context.prs.length === 0) {
        void reporter?.ticketInProgress(ticket, 0);
      }
      if (decision.dispatch) {
        if (slot.latestTask.resultStatus === null) {
          logger.debug({ ticket: ticket.identifier }, "ticket already has active SQL task; skipping dispatch");
        } else {
          toDispatch.push({ context: decision.context, trigger: decision.trigger });
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

/** Step 2 — admit newly delegated non-terminal tickets into free slots. */
async function admitNewTickets(
  tasks: TaskQueue,
  linear: LinearSource,
  agentId: string,
  free: number,
  logger: Logger,
  reporter?: DashboardReporter,
): Promise<DispatchItem[]> {
  if (free <= 0) {
    return [];
  }
  const [candidates, tracked] = await Promise.all([linear.findDelegatedTickets(agentId), tasks.listTracked()]);
  const trackedTicketIds = new Set(tracked.map((slot) => slot.ticketId));
  const admitted = selectAdmissions(candidates, (identifier) => trackedTicketIds.has(identifier), free);
  const contexts: DispatchItem[] = [];
  for (const ticket of admitted) {
    const context: TicketContext = { ticket, prs: [] };
    void reporter?.ticketDiscovered(ticket);
    logger.info({ ticket: ticket.identifier }, "picked up ticket");
    contexts.push({ context, trigger: "new" });
  }
  return contexts;
}

/** Step 3 — dispatch the given contexts to the handler, skipping any already in flight. */
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

/** Run the handler for one ticket. Removal is PR/Linear-driven during refresh. */
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
    logger.info(
      { ticket: context.ticket.identifier, taskId: outcome.taskId ?? null, status: outcome.status },
      "ticket handling queued",
    );
  } catch (err) {
    logger.error({ err, ticket: context.ticket.identifier }, "ticket handling failed");
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Step 2.5 — drop tickets that have reached MAX_ITERATIONS, hand them back to
 * their human assignee with an explanatory comment, and release their slot.
 */
async function enforceIterationLimit(
  items: DispatchItem[],
  tasks: TaskQueue,
  linear: LinearSource,
  logger: Logger,
): Promise<DispatchItem[]> {
  const eligible: DispatchItem[] = [];
  for (const item of items) {
    const ctx = item.context;
    // Tasks are keyed by ticket identifier (e.g. "DEN-123"); Linear APIs by ticket id (UUID).
    try {
      const count = await tasks.getIterationCount(ctx.ticket.identifier);
      if (count >= MAX_ITERATIONS) {
        logger.warn(
          { ticket: ctx.ticket.identifier, count },
          "iteration limit reached; handing back",
        );
        await linear.commentAndHandBack(
          ctx.ticket.id,
          `Reached the maximum iteration limit of ${MAX_ITERATIONS}. No further automated work will be attempted. Please review the history and re-delegate if you'd like to try again.`,
        );
        await tasks.setSlotStatus(ctx.ticket.identifier, "released");
      } else {
        eligible.push(item);
      }
    } catch (err) {
      // Isolate per-ticket failures so a transient Linear/DB error for one ticket
      // doesn't abort iteration-limit checks (and dispatch) for the rest of the batch.
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
  const prs = task.result?.prs ?? task.input.prs;
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
