import PQueue from "p-queue";

import type {
  Logger,
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
  Ticket,
  TicketContext,
  WorkOutcome,
} from "../shared/index.js";

import type { TicketPhase, TicketStore } from "./state.js";
import type { TaskQueue } from "./tasks.js";

/** The Linear capabilities the scheduler needs (subset of LinearIntegration). */
export interface LinearSource {
  findDelegatedTickets(agentId: string): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket>;
  /** Relinquish the agent's delegation so the ticket returns to its human assignee. */
  handBack(ticketId: string): Promise<void>;
}

/** The GitHub capabilities the scheduler needs (subset of GitHubIntegration). */
export interface GitHubSource {
  /** Find the open PR for a ticket without a known PR yet (returns null if none). */
  findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null>;
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
  store: TicketStore;
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
   * One poll cycle: refresh tracked tickets (releasing merged/closed PRs and collecting those
   * that need work), admit new tickets into free slots, then dispatch the eligible set.
   */
  async tick(): Promise<void> {
    const { store, tasks, linear, github, handler, logger, agentId, concurrency } = this.deps;

    logger.info({ active: store.count() }, "poll tick started");

    await recordCompletedTaskResults(store, tasks, logger);
    const refreshed = await refreshTrackedTickets(store, linear, github, agentId, logger);
    const admitted = await admitNewTickets(
      store,
      linear,
      github,
      agentId,
      freeSlots(concurrency, store.count()),
      logger,
    );

    const toDispatch = [...refreshed, ...admitted];
    dispatchTickets(toDispatch, handler, this.queue, this.inFlight, store, logger);

    logger.info(
      { active: store.count(), admitted: admitted.length, dispatched: toDispatch.length },
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
  isTracked: (id: string) => boolean,
  free: number,
): Ticket[] {
  if (free <= 0) {
    return [];
  }
  return candidates.filter((ticket) => !isTracked(ticket.id)).slice(0, free);
}

// ---------------------------------------------------------------------------
// Effectful steps (each one cycle stage)
// ---------------------------------------------------------------------------

interface TicketDecision {
  /** Release the ticket from memory (its PR is merged or closed). */
  remove: boolean;
  /** PR was merged (subset of `remove`); the ticket should be handed back to its human assignee. */
  merged: boolean;
  context: TicketContext;
  /** Hand the ticket to the worker this tick. */
  dispatch: boolean;
  /** Whether the ticket is currently the manager's ("active") or parked with someone else. */
  phase: TicketPhase;
}

function refToContext(pr: PullRequest): PullRequestRef {
  return { owner: pr.owner, repo: pr.repo, number: pr.number };
}

/**
 * Refresh one tracked ticket and decide what to do with it.
 * - Not delegated to the manager → parked: held in its slot, not dispatched, GitHub left alone
 *   (it is waiting on its human owner, e.g. the creator answering the worker's question).
 * - Delegated to the manager, just back from parked → resume: re-dispatched (unless its PR is
 *   already merged/closed, which releases it).
 * - Known PR → look it up by ref; merged/closed releases it, otherwise dispatch iff it has
 *   failed tests or unresolved review comments.
 * - No PR yet → search open PRs; a fresh, still-PR-less ticket is dispatched only on the resume
 *   edge — the admission dispatch already covered its first run.
 */
async function evaluateTicket(
  ticket: Ticket,
  knownPr: PullRequest | null,
  prevPhase: TicketPhase,
  agentId: string,
  github: GitHubSource,
  logger: Logger,
): Promise<TicketDecision> {
  if (ticket.delegate?.id !== agentId) {
    logger.debug(
      { ticket: ticket.identifier, delegate: ticket.delegate?.id ?? null },
      "ticket not delegated to manager; parking",
    );
    return { remove: false, merged: false, context: { ticket, pr: knownPr }, dispatch: false, phase: "parked" };
  }

  const resuming = prevPhase === "parked";
  if (resuming) {
    logger.info({ ticket: ticket.identifier }, "ticket re-delegated to manager; resuming");
  }

  if (knownPr) {
    const status = await github.getPullRequestStatus(refToContext(knownPr));
    return decideForOpenPr(ticket, status, resuming, logger);
  }

  logger.debug({ ticket: ticket.identifier }, "looking for pull request");
  const found = await github.findPullRequestForTicket(ticket);
  if (found === null) {
    return { remove: false, merged: false, context: { ticket, pr: null }, dispatch: resuming, phase: "active" };
  }
  logger.info(
    { ticket: ticket.identifier, pr: found.number, headRef: found.headRef },
    "found pull request for ticket",
  );
  if (found.merged || found.state === "closed") {
    return { remove: true, merged: found.merged, context: { ticket, pr: found }, dispatch: false, phase: "active" };
  }
  const status = await github.getPullRequestStatus(refToContext(found));
  return decideForOpenPr(ticket, status, resuming, logger);
}

function decideForOpenPr(
  ticket: Ticket,
  status: PullRequestStatus,
  resuming: boolean,
  logger: Logger,
): TicketDecision {
  const { pr, testsFailed, hasUnresolvedComments } = status;
  if (pr.merged || pr.state === "closed") {
    logger.info(
      { ticket: ticket.identifier, pr: pr.number, merged: pr.merged, state: pr.state },
      "pull request resolved; releasing ticket",
    );
    return { remove: true, merged: pr.merged, context: { ticket, pr }, dispatch: false, phase: "active" };
  }
  const dispatch = resuming || testsFailed || hasUnresolvedComments;
  if (dispatch) {
    logger.info(
      { ticket: ticket.identifier, pr: pr.number, resuming, testsFailed, hasUnresolvedComments },
      "pull request needs work; re-dispatching",
    );
  }
  return { remove: false, merged: false, context: { ticket, pr }, dispatch, phase: "active" };
}

/** Step 1 — refresh tracked tickets, release resolved PRs, collect those needing dispatch. */
async function refreshTrackedTickets(
  store: TicketStore,
  linear: LinearSource,
  github: GitHubSource,
  agentId: string,
  logger: Logger,
): Promise<TicketContext[]> {
  const toDispatch: TicketContext[] = [];
  for (const { context, phase } of store.all()) {
    const ticket = await linear.getTicket(context.ticket.id);
    const decision = await evaluateTicket(ticket, context.pr, phase, agentId, github, logger);
    if (decision.remove) {
      if (decision.merged) {
        // PR merged — relinquish the agent's delegation so the ticket returns to its human assignee.
        // If this throws, leave the ticket tracked so the next tick retries.
        await linear.handBack(ticket.id);
        logger.info({ ticket: ticket.identifier }, "handed ticket back to assignee after merge");
      }
      store.remove(ticket.id);
      continue;
    }
    store.upsert(ticket.id, decision.context, decision.phase);
    if (decision.dispatch) {
      toDispatch.push(decision.context);
    }
  }
  return toDispatch;
}

/** Step 2 — admit newly delegated tickets after checking whether they already have a PR. */
async function admitNewTickets(
  store: TicketStore,
  linear: LinearSource,
  github: GitHubSource,
  agentId: string,
  free: number,
  logger: Logger,
): Promise<TicketContext[]> {
  if (free <= 0) {
    return [];
  }
  const candidates = await linear.findDelegatedTickets(agentId);
  const admitted = selectAdmissions(candidates, (id) => store.has(id), free);
  const contexts: TicketContext[] = [];
  for (const ticket of admitted) {
    const pr = await github.findPullRequestForTicket(ticket);
    if (pr) {
      logger.info({ ticket: ticket.identifier, pr: pr.number, headRef: pr.headRef }, "found pull request for admitted ticket");
    }
    const context: TicketContext = { ticket, pr };
    store.upsert(ticket.id, context);
    logger.info({ ticket: ticket.identifier }, "picked up ticket");
    contexts.push(context);
  }
  return contexts;
}

/** Step 3 — dispatch the given contexts to the handler, skipping any already in flight. */
function dispatchTickets(
  contexts: TicketContext[],
  handler: TicketHandler,
  queue: PQueue,
  inFlight: Set<string>,
  store: TicketStore,
  logger: Logger,
): void {
  for (const context of contexts) {
    const id = context.ticket.id;
    if (inFlight.has(id)) {
      continue;
    }
    if (store.get(id)?.activeTaskId !== null) {
      logger.debug({ ticket: context.ticket.identifier }, "ticket already has active SQL task; skipping dispatch");
      continue;
    }
    inFlight.add(id);
    void queue.add(() => runHandler(context, handler, store, inFlight, logger));
  }
}

/** Run the handler for one ticket and record its dispatch status. Removal is PR-driven (refresh). */
async function runHandler(
  context: TicketContext,
  handler: TicketHandler,
  store: TicketStore,
  inFlight: Set<string>,
  logger: Logger,
): Promise<void> {
  const id = context.ticket.id;
  try {
    const outcome = await handler.handle(context);
    // The ticket may have been released by a concurrent refresh (merged/closed PR).
    if (store.has(id)) {
      if (outcome.taskId) {
        store.setActiveTask(id, outcome.taskId);
      }
      store.setStatus(id, outcome.status);
    }
  } catch (err) {
    logger.error({ err, ticket: context.ticket.identifier }, "ticket handling failed");
  } finally {
    inFlight.delete(id);
  }
}

async function recordCompletedTaskResults(
  store: TicketStore,
  tasks: TaskQueue,
  logger: Logger,
): Promise<void> {
  const tracked = store
    .all()
    .filter((ticket) => ticket.activeTaskId !== null)
    .map((ticket) => ({ ticketId: ticket.context.ticket.id, ticket: ticket.context.ticket.identifier, taskId: ticket.activeTaskId! }));
  if (tracked.length === 0) {
    return;
  }
  const completed = await tasks.getCompleted(tracked.map((ticket) => ticket.taskId));
  const byTaskId = new Map(completed.map((task) => [task.id, task]));
  for (const trackedTask of tracked) {
    const task = byTaskId.get(trackedTask.taskId);
    if (!task) {
      continue;
    }
    if (task.resultStatus === null) {
      throw new Error(`Completed task is missing result status: ${task.id}`);
    }
    if (!store.has(trackedTask.ticketId)) {
      continue;
    }
    store.setStatus(trackedTask.ticketId, task.resultStatus);
    store.clearActiveTask(trackedTask.ticketId);
    logger.info(
      { ticket: trackedTask.ticket, taskId: task.id, resultStatus: task.resultStatus },
      "recorded completed SQL task result",
    );
  }
}
