// src/shared/dashboard/types.ts

export type BmStatus =
  | "discovered" | "dispatched" | "in_progress" | "pr_open"
  | "ci_running" | "ci_failed" | "completed" | "abandoned";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type RunTrigger = "new" | "ci_failure" | "delegated_back";
export type StopReason = "completed" | "timeout" | "crash" | "error";
export type CiStatus = "running" | "passed" | "failed";
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
  maxAttempts: number;
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

export interface CiRunPayload {
  id: string;
  ticketId: string;
  runId: string | null;
  prId: string | null;
  status: CiStatus;
  url: string | null;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
}

/**
 * One failing CI check (test/lint/type). Identified by `id` for idempotent upsert across polls;
 * use `<ciRunId>:<source>:<externalId>` so re-polling the same SHA replaces the same row.
 */
export interface CiCheckPayload {
  id: string;
  ciRunId: string;
  /** "check_run" (GitHub Checks API) vs "status" (legacy commit status). */
  source: "check_run" | "status";
  /** GitHub check_run.id (string) or status context. */
  externalId: string;
  name: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
  /** Serialized GitHub annotations (line-level test/lint failures). */
  annotationsJson: string;
  createdAt: number;
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
