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

    // 1. Refresh active tickets — the only place GitHub is queried.
    for (const state of store.all()) {
      const id = state.context.ticket.id;
      const ticket = await linear.getTicket(id);
      const pr = await github.findPullRequestForTicket(ticket);
      store.upsert(id, { ticket, pr });
    }

    // 2. Admit new Todo tickets only if there are free slots.
    const free = concurrency - store.activeCount();
    let admitted = 0;
    if (free > 0) {
      const todo = await linear.findTicketsByLabel(label, { status: this.todoStatus });
      const toAdmit = todo.filter((ticket) => !store.isActive(ticket.id)).slice(0, free);
      for (const ticket of toAdmit) {
        store.upsert(ticket.id, { ticket, pr: null });
        admitted += 1;
      }
    }

    // 3. Dispatch each active ticket to the handler (skipping any already in flight).
    for (const state of store.all()) {
      const id = state.context.ticket.id;
      if (this.inFlight.has(id)) {
        continue;
      }
      this.inFlight.add(id);
      const ctx = state.context;
      void this.queue.add(async () => {
        try {
          const outcome = await handler.handle(ctx);
          if (outcome.done) {
            store.remove(id);
          }
        } catch (err) {
          logger.error({ err, ticket: ctx.ticket.identifier }, "ticket handling failed");
        } finally {
          this.inFlight.delete(id);
        }
      });
    }

    logger.info({ active: store.activeCount(), admitted }, "poll tick complete");
  }
}
