import type { TicketContext } from "../shared/index.js";

/** Minimal now; the future state machine adds members. */
export type WorkStatus = "active";

export interface TicketState {
  context: TicketContext;
  status: WorkStatus;
  /** When this ticket first took a worker slot. */
  admittedAt: Date;
  updatedAt: Date;
}

/** In-memory record of the tickets the manager is currently working. */
export class TicketStore {
  private readonly tickets = new Map<string, TicketState>();

  /** Insert or refresh a ticket as active, preserving its original admission time. */
  upsert(id: string, context: TicketContext): TicketState {
    const now = new Date();
    const existing = this.tickets.get(id);
    const state: TicketState = {
      context,
      status: "active",
      admittedAt: existing?.admittedAt ?? now,
      updatedAt: now,
    };
    this.tickets.set(id, state);
    return state;
  }

  get(id: string): TicketState | undefined {
    return this.tickets.get(id);
  }

  all(): TicketState[] {
    return [...this.tickets.values()];
  }

  activeCount(): number {
    let count = 0;
    for (const state of this.tickets.values()) {
      if (state.status === "active") {
        count += 1;
      }
    }
    return count;
  }

  isActive(id: string): boolean {
    return this.tickets.get(id)?.status === "active";
  }

  remove(id: string): void {
    this.tickets.delete(id);
  }
}
