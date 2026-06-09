import type { TicketContext } from "../shared/index.js";

/** Whether a ticket is being worked as a fresh task or an iteration on an existing PR. */
export type DispatchState = "new" | "iteration";

/** Worker dispatch outcome recorded per ticket. */
export type DispatchStatus = "pending" | "done";

export interface TicketState {
  context: TicketContext;
  /** Derived from PR presence: a ticket with no PR is "new", otherwise "iteration". */
  state: DispatchState;
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

  /** Insert or refresh a ticket, preserving its admission time and current status. */
  upsert(id: string, context: TicketContext): TicketState {
    const now = new Date();
    const existing = this.tickets.get(id);
    const state: TicketState = {
      context,
      state: context.pr ? "iteration" : "new",
      status: existing?.status ?? "pending",
      admittedAt: existing?.admittedAt ?? now,
      updatedAt: now,
    };
    this.tickets.set(id, state);
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
    this.tickets.delete(id);
  }
}
