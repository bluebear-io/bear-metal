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
  runId: string;
  prId: string | null;
  status: CiStatus;
  url: string | null;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface TokenUsagePayload {
  id: string;
  runId: string;
  ticketId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
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
