/** Workflow state of a Linear ticket (e.g. name "Todo", type "unstarted"). */
export interface TicketStatus {
  name: string;
  type: string;
}

/**
 * Lean Linear ticket contract used across the codebase. `@linear/sdk` models an
 * issue as a lazy client object rather than a plain data type, so we map it into
 * this flat shape at the integration boundary.
 */
export interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  /** Linear-suggested git branch name (used to match a ticket to its PR). */
  branchName: string;
  status: TicketStatus;
  labels: string[];
  /** Current assignee, or null if unassigned. The manager parks tickets not assigned to it. */
  assignee: { id: string } | null;
}

export interface TicketCommentUser {
  id: string;
  name: string;
  email: string;
}

export interface TicketComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  quotedText: string | null;
  user: TicketCommentUser | null;
}

export interface LinearTicketContext {
  issue: Ticket;
  comments: TicketComment[];
}

export interface FindTicketsOptions {
  /** Filter by Linear workflow-state name (e.g. "Todo"). */
  status?: string;
}
