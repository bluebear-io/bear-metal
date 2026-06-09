import type { PullRequest } from "./integrations/github/types.js";
import type { Ticket } from "./integrations/linear/types.js";

/** Full per-ticket data handed to the manager's ticket handler. PR is optional. */
export interface TicketContext {
  ticket: Ticket;
  pr: PullRequest | null;
}

/** The handler's result to the scheduler. `done` releases the ticket's slot. */
export interface WorkOutcome {
  done: boolean;
}

export type WorkerStatus = "noop" | "pending" | "done";

/** The worker's response to the handler. */
export interface WorkerResponse {
  status: WorkerStatus;
}
