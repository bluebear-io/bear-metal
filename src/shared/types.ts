import type { PullRequest } from "./integrations/github/types.js";
import type { Ticket } from "./integrations/linear/types.js";

/** Full per-ticket data handed to the manager's ticket handler. PR is optional. */
export interface TicketContext {
  ticket: Ticket;
  pr: PullRequest | null;
}

export type WorkerStatus = "pending" | "done";

/** The handler's result to the scheduler. */
export interface WorkOutcome {
  status: WorkerStatus;
  taskId?: string;
}

/** The worker's response to the handler. */
export interface WorkerResponse {
  status: WorkerStatus;
}
