// src/shared/dashboard/types.ts

export type BmStatus = "in_progress" | "validating" | "waiting_for_human" | "completed";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type RunTrigger = "new" | "ci_failure" | "delegated_back" | "merge_conflict";
export type StopReason = "completed" | "timeout" | "crash" | "error";
export type EventSource = "manager" | "worker" | "ci";
export type EventType =
  | "ticket_discovered" | "dispatched" | "branch_created" | "progress"
  | "pr_opened" | "ci_started" | "ci_passed" | "ci_failed" | "delegated_back"
  | "worker_timeout" | "worker_crashed" | "ticket_completed" | "ticket_abandoned";

export interface TicketPayload {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  linearStatusName: string;
  linearStatusType: string;
  labels: string[];
  bmStatus: BmStatus;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkerPayload {
  id: string;
  name: string;
  status: WorkerStatus;
  currentRunId: string | null;
  lastHeartbeatAt: number | null;
  startedAt: number;
  updatedAt: number;
}

export interface RunPayload {
  id: string;
  ticketId: string;
  attemptNumber: number;
  workerId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  contextJson: string | null;
  startedAt: number | null;
  endedAt: number | null;
  stopReason: StopReason | null;
  error: string | null;
  // LLM usage stats from the pi agent session (DEN-2313). Nullable: unknown for older runs
  // and for runs that crashed before any model call.
  promptTokens: number | null;
  completionTokens: number | null;
  modelName: string | null;
  provider: string | null;
  createdAt: number;
}

export interface PullRequestPayload {
  id: string;
  ticketId: string;
  number: number;
  title: string;
  headRef: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  url: string;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One PR review thread (resolved or unresolved) with its full comment chain. */
export interface ReviewThreadPayload {
  /** GitHub GraphQL node id of the thread. */
  id: string;
  prId: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  /** Serialized ReviewThreadComment[]. */
  commentsJson: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One step in the agent's tool-call timeline for a single run (DEN-2311). The worker sends the
 * full ordered list at run completion; the backend replaces all rows for the run id.
 */
export interface RunToolCallPayload {
  id: string;
  runId: string;
  sequence: number;
  toolName: string;
  argsJson: string;
  resultText: string | null;
  /** "ok" / "error" / "unknown". Null when the run aborted before any result block arrived. */
  resultStatus: "ok" | "error" | "unknown" | null;
  outputSize: number | null;
  thoughtText: string | null;
  createdAt: number;
}

export interface EventPayload {
  ticketId: string | null;
  runId: string | null;
  workerId: string | null;
  source: EventSource;
  type: EventType;
  summary: string;
  payloadJson: string | null;
  createdAt: number;
}
