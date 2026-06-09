import PQueue from "p-queue";

import type {
  FindTicketsOptions,
  Logger,
  PullRequest,
  Ticket,
  TicketContext,
  WorkOutcome,
} from "../shared/index.js";

import type { TicketStore } from "./state.js";

/** The Linear capabilities the scheduler needs (subset of LinearIntegration). */
export interface LinearSource {
  findTicketsByLabel(label: string, options?: FindTicketsOptions): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket>;
}

/** The GitHub capabilities the scheduler needs (subset of GitHubIntegration). */
export interface GitHubSource {
  findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null>;
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
  handler: TicketHandler;
  label: string;
  concurrency: number;
  pollIntervalMs: number;
  /** Linear workflow-state name new tickets are admitted from. */
  todoStatus?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Open worker slots given the concurrency cap and the current active count. */
export function freeSlots(concurrency: number, activeCount: number): number {
  return Math.max(0, concurrency - activeCount);
}

/** Pick which candidate tickets to admit: not already active, capped at free slots. */
export function selectAdmissions(
  candidates: Ticket[],
  isActive: (id: string) => boolean,
  free: number,
): Ticket[] {
  if (free <= 0) {
    return [];
  }
  return candidates.filter((ticket) => !isActive(ticket.id)).slice(0, free);
}

// ---------------------------------------------------------------------------
// Effectful steps (each one cycle stage)
// ---------------------------------------------------------------------------

/** Merge a ticket with its GitHub PR (PR optional). The only place GitHub is queried. */
async function buildContext(ticket: Ticket, github: GitHubSource): Promise<TicketContext> {
  const pr = await github.findPullRequestForTicket(ticket);
  return { ticket, pr };
}

/** Step 1 — re-fetch every active ticket and refresh its merged context. */
async function refreshActiveTickets(
  store: TicketStore,
  linear: LinearSource,
  github: GitHubSource,
): Promise<void> {
  for (const { context } of store.all()) {
    const ticket = await linear.getTicket(context.ticket.id);
    store.upsert(ticket.id, await buildContext(ticket, github));
  }
}

/** Step 2 — admit new Todo tickets into free slots; returns how many were admitted. */
async function admitNewTickets(
  store: TicketStore,
  linear: LinearSource,
  label: string,
  todoStatus: string,
  free: number,
): Promise<number> {
  if (free <= 0) {
    return 0;
  }
  const candidates = await linear.findTicketsByLabel(label, { status: todoStatus });
  const admitted = selectAdmissions(candidates, (id) => store.isActive(id), free);
  for (const ticket of admitted) {
    store.upsert(ticket.id, { ticket, pr: null });
  }
  return admitted.length;
}

/** Step 3 — dispatch each active ticket not already in flight to the handler. */
function dispatchActiveTickets(
  store: TicketStore,
  handler: TicketHandler,
  queue: PQueue,
  inFlight: Set<string>,
  logger: Logger,
): void {
  for (const { context } of store.all()) {
    if (inFlight.has(context.ticket.id)) {
      continue;
    }
    inFlight.add(context.ticket.id);
    void queue.add(() => runHandler(context, handler, store, inFlight, logger));
  }
}

/** Run the handler for one ticket and release its slot/in-flight guard afterwards. */
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
    if (outcome.done) {
      store.remove(id);
    }
  } catch (err) {
    logger.error({ err, ticket: context.ticket.identifier }, "ticket handling failed");
  } finally {
    inFlight.delete(id);
  }
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
  private readonly todoStatus: string;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.todoStatus = deps.todoStatus ?? "Todo";
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

  /** One poll cycle: refresh active tickets, admit new work, dispatch decisions. */
  async tick(): Promise<void> {
    const { store, linear, github, handler, logger, label, concurrency } = this.deps;

    await refreshActiveTickets(store, linear, github);

    const admitted = await admitNewTickets(
      store,
      linear,
      label,
      this.todoStatus,
      freeSlots(concurrency, store.activeCount()),
    );

    dispatchActiveTickets(store, handler, this.queue, this.inFlight, logger);

    logger.info({ active: store.activeCount(), admitted }, "poll tick complete");
  }
}
