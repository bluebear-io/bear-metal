export type BmStatus =
  | "discovered"
  | "dispatched"
  | "in_progress"
  | "pr_open"
  | "ci_running"
  | "ci_failed"
  | "completed"
  | "abandoned";

export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type RunTrigger = "new" | "ci_failure" | "delegated_back";
export type CiStatus = "running" | "passed" | "failed";

export interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  linearStatusName: string;
  linearStatusType: string;
  labelsJson: string;
  bmStatus: BmStatus;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface LatestRunSummary {
  id: string;
  attemptNumber: number;
  status: RunStatus;
  trigger: RunTrigger;
  workerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface TicketListItem extends Ticket {
  latestRun: LatestRunSummary | null;
  latestPr: { number: number; url: string; state: "open" | "closed"; merged: boolean } | null;
  latestCiStatus: CiStatus | null;
}

export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  currentRunId: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface CurrentRunSummary extends LatestRunSummary {
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  runtimeMs: number | null;
}

export interface WorkerListItem extends Worker {
  currentTicketIdentifier: string | null;
  currentTicketTitle: string | null;
  currentRun: CurrentRunSummary | null;
  heartbeatAgeMs: number | null;
  isDead: boolean;
  isHeartbeatStale: boolean;
  isTimedOut: boolean;
}

export interface Run {
  id: string;
  ticketId: string;
  attemptNumber: number;
  workerId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  contextJson: string | null;
  startedAt: string | null;
  endedAt: string | null;
  stopReason: "completed" | "timeout" | "crash" | "error" | null;
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  modelName: string | null;
  provider: string | null;
  /** Estimated USD cost from the backend pricing table; null when pricing or tokens are missing. */
  estimatedCostUsd: number | null;
  createdAt: string;
  worker: Worker | null;
}

export interface ModelComparisonRow {
  family: "claude" | "gpt" | "gemini" | "other";
  provider: string;
  modelName: string;
  totalRuns: number;
  succeededRuns: number;
  successRate: number;
  avgDurationSeconds: number | null;
  runsWithDuration: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  avgCostUsd: number;
}

export interface PullRequest {
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
  createdAt: string;
  updatedAt: string;
}

export interface CiRun {
  id: string;
  ticketId: string;
  runId: string;
  prId: string | null;
  status: CiStatus;
  url: string | null;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TicketEvent {
  id: string;
  ticketId: string | null;
  runId: string | null;
  workerId: string | null;
  source: "manager" | "worker" | "ci";
  type: string;
  summary: string;
  payloadJson: string | null;
  createdAt: string;
}

export interface TicketDetail {
  ticket: Ticket;
  runs: Run[];
  pullRequests: PullRequest[];
  ciRuns: CiRun[];
  events: TicketEvent[];
}
