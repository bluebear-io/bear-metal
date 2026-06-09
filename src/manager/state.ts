import type { Logger, TicketContext } from "../shared/index.js";

/** Whether a ticket is being worked as a fresh task or an iteration on an existing PR. */
export type DispatchState = "new" | "iteration";

/** Worker dispatch outcome recorded per ticket. */
export type DispatchStatus = "pending" | "done";

/**
 * Whether the manager owns the ticket right now. A ticket reassigned to someone else
 * (e.g. the worker handed it back to the creator with a question) is "parked": it keeps
 * its slot but is not dispatched until it is reassigned back to the manager.
 */
export type TicketPhase = "active" | "parked";

export interface TicketState {
  context: TicketContext;
  /** Derived from PR presence: a ticket with no PR is "new", otherwise "iteration". */
  state: DispatchState;
  /** Whether the ticket is currently assigned to the manager ("active") or parked. */
  phase: TicketPhase;
  status: DispatchStatus;
  /** When this ticket first took a worker slot. */
  admittedAt: Date;
  updatedAt: Date;
}

/**
 * In-memory record of the tickets the manager is currently working. Every tracked
 * ticket occupies a concurrency slot; finished iterations are removed by the scheduler.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketState>();
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /** Insert or refresh a ticket, preserving its admission time and current status. */
  upsert(id: string, context: TicketContext, phase: TicketPhase = "active"): TicketState {
    const now = new Date();
    const existing = this.tickets.get(id);
    const state: TicketState = {
      context,
      state: context.pr ? "iteration" : "new",
      phase,
      status: existing?.status ?? "pending",
      admittedAt: existing?.admittedAt ?? now,
      updatedAt: now,
    };
    this.tickets.set(id, state);
    this.logger?.info(
      {
        ticket: context.ticket.identifier,
        change: existing ? "refreshed" : "added",
        state: state.state,
        phase: state.phase,
        status: state.status,
        count: this.tickets.size,
      },
      "memory: ticket upserted",
    );
    return state;
  }

  /** Record the worker dispatch status for a tracked ticket. */
  setStatus(id: string, status: DispatchStatus): TicketState {
    const existing = this.tickets.get(id);
    if (!existing) {
      throw new Error(`Cannot set status for unknown ticket: ${id}`);
    }
    const updated: TicketState = { ...existing, status, updatedAt: new Date() };
    this.tickets.set(id, updated);
    this.logger?.info(
      {
        ticket: updated.context.ticket.identifier,
        previousStatus: existing.status,
        status: updated.status,
        state: updated.state,
        count: this.tickets.size,
      },
      "memory: ticket status updated",
    );
    return updated;
  }

  get(id: string): TicketState | undefined {
    return this.tickets.get(id);
  }

  all(): TicketState[] {
    return [...this.tickets.values()];
  }

  count(): number {
    return this.tickets.size;
  }

  has(id: string): boolean {
    return this.tickets.has(id);
  }

  remove(id: string): void {
    const existing = this.tickets.get(id);
    if (!this.tickets.delete(id)) {
      return;
    }
    this.logger?.info(
      {
        ticket: existing?.context.ticket.identifier ?? id,
        count: this.tickets.size,
      },
      "memory: ticket removed",
    );
  }
}
