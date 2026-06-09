import PQueue from "p-queue";

import type {
  Logger,
  PullRequestRef,
  PullRequestStatus,
  Ticket,
  TicketContext,
  WorkOutcome,
} from "../shared/index.js";

import type { TaskQueue, TaskSlot } from "./tasks.js";

type TicketPhase = "active" | "parked";

const TERMINAL_STATE_TYPES = ["completed", "canceled"];
const TERMINAL_STATE_NAMES = ["Merged"];

const MAX_ITERATIONS = 20;

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
}

/** The decision capability the scheduler needs (satisfied by ManagerTicketHandler). */
export interface TicketHandler {
  handle(ctx: TicketContext): Promise<WorkOutcome>;
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
}

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
    const { tasks, linear, github, handler, logger, agentId, concurrency } = this.deps;

    logger.info({ active: await tasks.countTracked() }, "poll tick started");

    const refreshed = await refreshTrackedTickets(tasks, linear, github, agentId, logger);
    const admitted = await admitNewTickets(
      tasks,
      linear,
      agentId,
      freeSlots(concurrency, await tasks.countTracked()),
      logger,
    );

    const toDispatch = [...refreshed, ...admitted];
    const eligible = await enforceIterationLimit(toDispatch, tasks, linear, logger);
    await dispatchTickets(eligible, handler, this.queue, this.inFlight, logger);

    logger.info(
      { active: await tasks.countTracked(), admitted: admitted.length, dispatched: eligible.length },
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

/** Pick which candidate tickets to admit: not already tracked, capped at free slots. */
export function selectAdmissions(
  candidates: Ticket[],
  isTracked: (identifier: string) => boolean,
  free: number,
): Ticket[] {
  if (free <= 0) {
    return [];
  }
  return candidates.filter((ticket) => !isTracked(ticket.identifier)).slice(0, free);
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
  knownPr: PullRequestRef | null,
  prevPhase: TicketPhase,
  agentId: string,
  github: GitHubSource,
  logger: Logger,
): Promise<TicketDecision> {
  if (isTerminalLinearTicket(ticket)) {
    logger.info(
      { ticket: ticket.identifier, statusName: ticket.status.name, statusType: ticket.status.type },
      "linear ticket is terminal; releasing slot",
    );
    return { remove: true, merged: false, context: { ticket, pr: null }, dispatch: false, phase: "active" };
  }

  if (ticket.delegate?.id !== agentId) {
    logger.debug(
      { ticket: ticket.identifier, delegate: ticket.delegate?.id ?? null },
      "ticket not delegated to manager; parking",
    );
    return { remove: false, merged: false, context: { ticket, pr: null }, dispatch: false, phase: "parked" };
  }

  const resuming = prevPhase === "parked";
  if (resuming) {
    logger.info({ ticket: ticket.identifier }, "ticket re-delegated to manager; resuming");
  }

  if (knownPr) {
    const status = await github.getPullRequestStatus(knownPr);
    return decideForOpenPr(ticket, status, resuming, logger);
  }

  return { remove: false, merged: false, context: { ticket, pr: null }, dispatch: resuming, phase: "active" };
}

function decideForOpenPr(
  ticket: Ticket,
  status: PullRequestStatus,
  resuming: boolean,
  logger: Logger,
): TicketDecision {
  const { pr, testsFailed, hasActionableUnresolvedComments } = status;
  if (pr.merged || pr.state === "closed") {
    logger.info(
      { ticket: ticket.identifier, pr: pr.number, merged: pr.merged, state: pr.state },
      "pull request resolved; releasing ticket",
    );
    return { remove: true, merged: pr.merged, context: { ticket, pr }, dispatch: false, phase: "active" };
  }
  const dispatch = resuming || testsFailed || hasActionableUnresolvedComments;
  if (dispatch) {
    logger.info(
      { ticket: ticket.identifier, pr: pr.number, resuming, testsFailed, hasActionableUnresolvedComments },
      "pull request needs work; re-dispatching",
    );
  }
  return { remove: false, merged: false, context: { ticket, pr }, dispatch, phase: "active" };
}

/** Step 1 — refresh tracked SQL slots, release resolved slots, collect those needing dispatch. */
async function refreshTrackedTickets(
  tasks: TaskQueue,
  linear: LinearSource,
  github: GitHubSource,
  agentId: string,
  logger: Logger,
): Promise<TicketContext[]> {
  const toDispatch: TicketContext[] = [];
  for (const slot of await tasks.listTracked()) {
    try {
      const knownPr = knownPrForSlot(slot);
      const ticket = await linear.getTicket(slot.ticketId);
      const decision = await evaluateTicket(ticket, knownPr, slot.slotStatus, agentId, github, logger);
      if (decision.remove) {
        if (decision.merged) {
          // PR merged — relinquish the agent's delegation so the ticket returns to its human assignee.
          // If this throws, leave the slot tracked so the next tick retries.
          await linear.handBack(ticket.id);
          logger.info({ ticket: ticket.identifier }, "handed ticket back to assignee after merge");
        }
        await tasks.setSlotStatus(slot.ticketId, "released");
        continue;
      }

      if (slot.slotStatus !== decision.phase) {
        await tasks.setSlotStatus(slot.ticketId, decision.phase);
      }
      if (decision.dispatch) {
        if (slot.latestTask.resultStatus === null) {
          logger.debug({ ticket: ticket.identifier }, "ticket already has active SQL task; skipping dispatch");
        } else {
          toDispatch.push(decision.context);
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
): Promise<TicketContext[]> {
  if (free <= 0) {
    return [];
  }
  const [candidates, tracked] = await Promise.all([linear.findDelegatedTickets(agentId), tasks.listTracked()]);
  const trackedTicketIds = new Set(tracked.map((slot) => slot.ticketId));
  const admitted = selectAdmissions(candidates, (identifier) => trackedTicketIds.has(identifier), free);
  const contexts: TicketContext[] = [];
  for (const ticket of admitted) {
    const context: TicketContext = { ticket, pr: null };
    logger.info({ ticket: ticket.identifier }, "picked up ticket");
    contexts.push(context);
  }
  return contexts;
}

/** Step 3 — dispatch the given contexts to the handler, skipping any already in flight. */
async function dispatchTickets(
  contexts: TicketContext[],
  handler: TicketHandler,
  queue: PQueue,
  inFlight: Set<string>,
  logger: Logger,
): Promise<void> {
  const work: Array<Promise<void>> = [];
  for (const context of contexts) {
    const id = context.ticket.identifier;
    if (inFlight.has(id)) {
      continue;
    }
    inFlight.add(id);
    work.push(queue.add(() => runHandler(context, handler, inFlight, logger)));
  }
  await Promise.all(work);
}

/** Run the handler for one ticket. Removal is PR/Linear-driven during refresh. */
async function runHandler(
  context: TicketContext,
  handler: TicketHandler,
  inFlight: Set<string>,
  logger: Logger,
): Promise<void> {
  const id = context.ticket.identifier;
  try {
    const outcome = await handler.handle(context);
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
  contexts: TicketContext[],
  tasks: TaskQueue,
  linear: LinearSource,
  logger: Logger,
): Promise<TicketContext[]> {
  const eligible: TicketContext[] = [];
  for (const ctx of contexts) {
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
        eligible.push(ctx);
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

function knownPrForSlot(slot: TaskSlot): PullRequestRef | null {
  const task = slot.latestTask;
  const pr = task.result?.pr ?? task.input.pr;
  if (task.resultStatus === "done" && pr === null) {
    throw new Error(`Task ${task.id} for ticket ${task.ticketId} completed with status done but has no pull request`);
  }
  return pr;
}

function isTerminalLinearTicket(ticket: Ticket): boolean {
  return TERMINAL_STATE_TYPES.includes(ticket.status.type) || TERMINAL_STATE_NAMES.includes(ticket.status.name);
}
