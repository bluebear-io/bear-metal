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
  /**
   * Linear priority value. Matches Linear's encoding: 0 = No priority, 1 = Urgent,
   * 2 = High, 3 = Medium, 4 = Low. Note the asymmetry — 0 means *unset*, not
   * "highest". The scheduler treats 0 as the lowest-priority bucket when ordering.
   */
  priority: number;
  labels: string[];
  /** Human owner of the ticket (stays the creator even when an agent is delegated to it). */
  assignee: { id: string } | null;
  /**
   * Agent the ticket is delegated to, or null. The manager works tickets delegated to it and
   * parks those that are not — Linear assigns agent work via delegation, not assignment.
   */
  delegate: { id: string } | null;
  /**
   * ISO timestamps populated by `LinearIntegration` for tickets returned from Linear. Optional so
   * test fixtures that hand-construct `Ticket` values don't need to fill them in — only callers
   * that need historical context (e.g. the backfill tool) read these.
   */
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
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
