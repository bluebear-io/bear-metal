/**
 * Unified database client for bear-metal.
 *
 * Single source of truth for all SQL. Replaces:
 *   - Drizzle ORM (src/backend/db/client.ts, repository.ts, writer.ts)
 *   - DashboardReporter HTTP calls (src/manager/dashboardReporter.ts)
 *   - TaskQueue (src/manager/tasks.ts)
 *
 * Supports SQLite (via node:sqlite DatabaseSync) and Postgres (via pg.Pool).
 * All `?` placeholders are rewritten to `$1, $2, ...` for Postgres via this.sql().
 * Dialect fork is limited to acquireNext and reclaimStaleTasks.
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { detectDialect, type DatabaseDialect } from "../manager/config.js";
function modelFamily(provider: string | null, modelName: string | null): "claude" | "gpt" | "gemini" | "other" {
  const p = (provider ?? "").toLowerCase();
  const m = (modelName ?? "").toLowerCase();
  if (p === "anthropic" || m.includes("claude")) return "claude";
  if (p === "openai" || m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("o4")) return "gpt";
  if (p === "google" || m.includes("gemini")) return "gemini";
  return "other";
}

// ---------------------------------------------------------------------------
// Types ported from src/backend/db/types.ts + repository.ts
// ---------------------------------------------------------------------------

export type BmStatus = "in_progress" | "validating" | "waiting_for_human" | "completed";

export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunTrigger = "new" | "ci_failure" | "delegated_back" | "merge_conflict";
export type StopReason = "completed" | "timeout" | "crash" | "error";

// Raw DB row shapes (snake_case, matching the tasks table columns)
export interface TaskRow {
  id: string;
  ticket_id: string | null;
  ticket_identifier: string | null;
  ticket_title: string | null;
  ticket_description: string | null;
  ticket_url: string | null;
  ticket_branch_name: string | null;
  ticket_linear_status_name: string | null;
  ticket_linear_status_type: string | null;
  ticket_labels_json: string;
  ts_status: string | null;
  attempt_count: number;
  ticket_completed_at: string | null;
  dispatch_state: string | null;
  input_json: string | null;
  worker_id: string | null;
  result_status: string | null;
  result_json: string | null;
  slot_status: string;
  iteration_number: number;
  worker_heartbeat_at: string | null;
  reclaim_count: number;
  attempt_number: number;
  run_status: string | null;
  trigger: string | null;
  started_at: string | null;
  ended_at: string | null;
  stop_reason: string | null;
  error: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model_name: string | null;
  provider: string | null;
  context_json: string | null;
  tool_calls_json: string | null;
  worker_started_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  released_at: string | null;
}

// ---------------------------------------------------------------------------
// Task queue types (ported from src/manager/tasks.ts)
// ---------------------------------------------------------------------------

export type SlotStatus = "active" | "parked" | "released";
export type DispatchState = "new" | "iteration";
export type ReclaimAction = "reclaimed" | "abandoned";

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface DispatchResult {
  status: "pending" | "done";
  prs: PullRequestRef[];
  notifyOnComplete?: boolean;
}

export interface DispatchTaskInput {
  state: DispatchState;
  ticketId: string;
  prs: PullRequestRef[];
  trigger: RunTrigger;
  ticketIssueId: string;
}

export interface TaskRecord {
  id: string;
  ticketId: string | null;
  dispatchState: DispatchState | null;
  attemptNumber: number;
  input: DispatchTaskInput | null;
  workerId: string | null;
  resultStatus: DispatchResult["status"] | null;
  result: DispatchResult | null;
  slotStatus: SlotStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  releasedAt: Date | null;
  iterationNumber: number;
  workerHeartbeatAt: Date | null;
  reclaimCount: number;
}

export interface ReclaimResult {
  task: TaskRecord;
  action: ReclaimAction;
  reason: string;
  previousWorkerId: string;
}

export interface ReclaimStaleOptions {
  staleAfterMs: number;
  maxReclaims: number;
}

export interface TaskSlot {
  ticketId: string | null;
  slotStatus: Exclude<SlotStatus, "released">;
  latestTask: TaskRecord;
}

// ---------------------------------------------------------------------------
// Dashboard / Repository types (ported from src/backend/db/repository.ts)
// ---------------------------------------------------------------------------

export const DEFAULT_TICKET_PAGE_SIZE = 50;
export const MAX_TICKET_PAGE_SIZE = 200;

export interface LatestRunSummary {
  id: string;
  attemptNumber: number;
  status: RunStatus | null;
  trigger: RunTrigger | null;
  workerId: string | null;
  stopReason: StopReason | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export interface CurrentRunSummary extends LatestRunSummary {
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  runtimeMs: number | null;
}

export interface TicketListItem {
  id: string;
  ticketId: string | null;
  ticketIdentifier: string | null;
  ticketTitle: string | null;
  ticketDescription: string | null;
  ticketUrl: string | null;
  ticketBranchName: string | null;
  ticketLinearStatusName: string | null;
  ticketLinearStatusType: string | null;
  ticketLabelsJson: string;
  bmStatus: BmStatus | null;
  attemptCount: number;
  ticketCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  latestRun: LatestRunSummary | null;
  latestWorkerName: string | null;
  latestPr: { number: number; url: string; state: string; merged: boolean } | null;
}

export interface ListTicketsOptions {
  q?: string;
  bmStatuses?: BmStatus[];
  workerIds?: string[];
  labels?: string[];
  stopReasons?: StopReason[];
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  pageSize?: number;
}

export interface ListTicketsResult {
  items: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TicketFilterOptions {
  bmStatuses: BmStatus[];
  statusCounts: Partial<Record<BmStatus, number>>;
  stopReasons: StopReason[];
  labels: string[];
  workers: Array<{ id: string; name: string }>;
}

export interface ReviewThread {
  id: string;
  prId: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  commentsJson: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PullRequestWithThreads {
  id: string;
  ticketId: string;
  number: number;
  title: string;
  headRef: string;
  state: string;
  draft: boolean;
  merged: boolean;
  url: string;
  lastRunId: string | null;
  reviewThreadsJson: string;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reviewThreads: ReviewThread[];
}

export interface RunToolCallRow {
  id: string;
  runId: string;
  sequence: number;
  toolName: string;
  argsJson: string;
  resultText: string | null;
  resultStatus: string | null;
  outputSize: number | null;
  thoughtText: string | null;
  createdAt: Date;
}

export interface RunWithUsage {
  id: string;
  ticketId: string | null;
  attemptNumber: number;
  workerId: string | null;
  trigger: RunTrigger | null;
  status: RunStatus | null;
  startedAt: Date | null;
  endedAt: Date | null;
  stopReason: StopReason | null;
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  modelName: string | null;
  provider: string | null;
  createdAt: Date;
  worker: { id: string; name: string } | null;
  toolCalls: RunToolCallRow[];
}

export interface TicketDetail {
  ticket: TicketListItem;
  runs: RunWithUsage[];
  pullRequests: PullRequestWithThreads[];
  events: Array<{
    id: string;
    ticketId: string | null;
    runId: string | null;
    workerId: string | null;
    source: string;
    type: string;
    summary: string;
    payloadJson: string | null;
    createdAt: Date;
  }>;
}

export interface WorkerListItem {
  id: string;
  name: string;
  status: WorkerStatus;
  currentRunId: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string;
  updatedAt: string;
  currentTicketIdentifier: string | null;
  currentTicketTitle: string | null;
  currentRun: CurrentRunSummary | null;
  heartbeatAgeMs: number | null;
  isDead: boolean;
  isHeartbeatStale: boolean;
  isTimedOut: boolean;
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
}

export interface ThroughputBlock {
  completed: number;
  abandoned: number;
  discovered: number;
}

export interface HealthBlock {
  successRate: number | null;
  avgAttempts: number | null;
  multiAttemptRate: number | null;
}

export interface ModelCostRow {
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
}

export interface CostBlock {
  promptTokens: number;
  completionTokens: number;
  byModel: ModelCostRow[];
}

export interface TimeBlock {
  avgWallClockSeconds: number | null;
  totalAgentSeconds: number;
  devHoursSaved: number;
}

export interface TicketRef {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface FailureBlock {
  ticketsAtMaxAttempts: TicketRef[];
}

export interface ShippedTicket extends TicketRef {
  labels: string[];
  prUrl: string;
  prNumber: number;
  completedAt: string | null;
}

export interface ShippedRepoBucket {
  repo: string;
  count: number;
  tickets: ShippedTicket[];
}

export interface ShippedBlock {
  byRepo: ShippedRepoBucket[];
}

export interface PeriodSummary {
  window: { from: string; to: string };
  prior: { from: string; to: string };
  throughput: ThroughputBlock & { prior: ThroughputBlock };
  health: HealthBlock & { prior: HealthBlock };
  cost: CostBlock & { prior: CostBlock };
  time: TimeBlock & { prior: TimeBlock };
  failures: FailureBlock;
  shipped: ShippedBlock;
}

export interface PeriodSummaryOptions {
  from: Date;
  to: Date;
}

// ---------------------------------------------------------------------------
// Input types for write methods
// ---------------------------------------------------------------------------

export interface TicketInput {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  linearStatusName: string;
  linearStatusType: string;
  labels: string[];
}


export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  modelName: string;
  provider: string;
}

export interface PullRequestInputData {
  number: number;
  title: string;
  headRef: string;
  state: string;
  draft: boolean;
  merged: boolean;
  url: string;
  lastRunId: string | null;
  reviewThreadsJson: string;
}

export interface EventInput {
  id: string;
  ticketId: string | null;
  runId: string | null;
  workerId: string | null;
  source: string;
  type: string;
  summary: string;
  payloadJson: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// DbClient interface
// ---------------------------------------------------------------------------

export interface DbClient {
  // Schema
  initSchema(): Promise<void>;

  // Ticket lifecycle
  upsertTicketDiscovered(ticket: TicketInput): Promise<void>;
  setTicketStatus(ticketId: string, status: BmStatus, notify?: boolean): Promise<void>;
  /** Returns the current status and notify flag for a ticket, or null if no row exists. For diagnostics only. */
  readTicketStatus(ticketId: string): Promise<{ status: string; notify: number } | null>;
  /** Atomically transitions a validating ticket to waiting_for_human and resets the notify flag.
   *  Returns true if the notify flag was consumed (Slack DM should fire). */
  tryTransitionToWaitingForHuman(ticketId: string): Promise<boolean>;

  // Run lifecycle
  upsertRunStarted(taskId: string, workerId: string, workerStartedAt: string): Promise<void>;
  upsertRunSucceeded(taskId: string, usage: RunUsage | null): Promise<void>;
  upsertRunCrashed(taskId: string, error: string): Promise<void>;
  upsertToolCalls(taskId: string, toolCallsJson: string): Promise<void>;

  // PR / CI
  upsertPullRequest(id: string, ticketId: string, data: PullRequestInputData): Promise<void>;
  markPrNotified(prId: string): Promise<void>;
  getPrNotifiedAt(prId: string): Promise<Date | null>;

  // Events
  recordEvent(event: EventInput): Promise<void>;

  // Comment store
  markCompleted(pr: PullRequestRef, commentId: string): Promise<void>;
  getCompleted(pr: PullRequestRef): Promise<Set<string>>;

  // Task queue
  enqueue(input: DispatchTaskInput): Promise<TaskRecord>;
  acquireNext(workerId: string): Promise<TaskRecord | null>;
  complete(taskId: string, result: DispatchResult): Promise<void>;
  listTracked(): Promise<TaskSlot[]>;
  countTracked(): Promise<number>;
  setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord>;
  getIterationCount(ticketId: string): Promise<number>;
  heartbeat(taskId: string, workerId: string): Promise<boolean>;
  reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]>;
  markCrashed(taskId: string, workerId: string, maxReclaims: number): Promise<ReclaimResult | null>;
  close(): Promise<void>;

  // Read (dashboard)
  listTickets(options: ListTicketsOptions): Promise<ListTicketsResult>;
  listTicketFilterOptions(): Promise<TicketFilterOptions>;
  getTicketDetail(id: string): Promise<TicketDetail | null>;
  listWorkers(): Promise<WorkerListItem[]>;
  listModelComparison(): Promise<ModelComparisonRow[]>;
  getPeriodSummary(options: PeriodSummaryOptions): Promise<PeriodSummary>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const WORKER_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEV_HOURS_PER_TICKET = 4;
// ---------------------------------------------------------------------------
// Monotonic ISO clock (same as tasks.ts — prevents duplicate timestamps)
// ---------------------------------------------------------------------------

class MonotonicIsoClock {
  private lastNowMs = 0;

  nowIso(): string {
    const nowMs = Date.now();
    const monotonicMs = Math.max(nowMs, this.lastNowMs + 1);
    this.lastNowMs = monotonicMs;
    return new Date(monotonicMs).toISOString();
  }
}

// ---------------------------------------------------------------------------
// Helper: extract sqlite file path from URL
// ---------------------------------------------------------------------------

function sqlitePath(databaseUrl: string): string {
  const path = databaseUrl.slice("sqlite:".length);
  if (!path) throw new Error("SQLite DATABASE_URL must include a file path");
  return path;
}

// ---------------------------------------------------------------------------
// Row parsing helpers
// ---------------------------------------------------------------------------

function parseTimestamp(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function parseTimestampRequired(value: string | Date | null | undefined, field: string): Date {
  const d = parseTimestamp(value);
  if (!d) throw new Error(`Required timestamp field "${field}" is null`);
  return d;
}

function parseSlotStatus(value: unknown): SlotStatus {
  if (value === "active" || value === "parked" || value === "released") return value;
  throw new Error(`Invalid task slot status: ${String(value)}`);
}

function parseDispatchState(value: unknown): DispatchState | null {
  if (value === null || value === undefined) return null;
  if (value === "new" || value === "iteration") return value;
  throw new Error(`Invalid dispatch state: ${String(value)}`);
}

function parseResultStatus(value: string | null): DispatchResult["status"] | null {
  if (value === null) return null;
  if (value === "pending" || value === "done") return value;
  throw new Error(`Invalid dispatch result status: ${String(value)}`);
}

function parseDispatchResult(value: string | null): DispatchResult | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const status = parseResultStatus(String(parsed.status)) as DispatchResult["status"];
  const prs = Array.isArray(parsed.prs)
    ? (parsed.prs as unknown[]).map((item) => parsePullRequestRef(item))
    : parsed.pr != null
      ? [parsePullRequestRef(parsed.pr)]
      : [];
  return { status, prs };
}

function parsePullRequestRef(value: unknown): PullRequestRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`PullRequestRef must be an object`);
  }
  const v = value as Record<string, unknown>;
  return {
    owner: String(v.owner),
    repo: String(v.repo),
    number: Number(v.number),
  };
}

function parseTaskInput(value: string | null): DispatchTaskInput | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const state = parseDispatchState(parsed.state);
  if (!state) throw new Error("task input_json missing state");
  const prs = Array.isArray(parsed.prs)
    ? (parsed.prs as unknown[]).map((item) => parsePullRequestRef(item))
    : parsed.pr != null
      ? [parsePullRequestRef(parsed.pr)]
      : [];
  return {
    state,
    ticketId: String(parsed.ticketId ?? ""),
    prs,
    trigger: parseTrigger(parsed.trigger),
    ticketIssueId: String(parsed.ticketIssueId ?? ""),
  };
}

function parseTrigger(value: unknown): RunTrigger {
  if (value === "new" || value === "ci_failure" || value === "delegated_back" || value === "merge_conflict") return value;
  // Default to "new" for rows created before trigger was tracked
  return "new";
}

function intBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1" || value === "true";
}

function rowToTaskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    dispatchState: parseDispatchState(row.dispatch_state),
    attemptNumber: Number(row.attempt_number ?? 1),
    input: parseTaskInput(row.input_json),
    workerId: row.worker_id,
    resultStatus: parseResultStatus(row.result_status),
    result: parseDispatchResult(row.result_json),
    slotStatus: parseSlotStatus(row.slot_status),
    createdAt: parseTimestampRequired(row.created_at, "created_at"),
    updatedAt: parseTimestampRequired(row.updated_at, "updated_at"),
    completedAt: parseTimestamp(row.completed_at),
    releasedAt: parseTimestamp(row.released_at),
    iterationNumber: Number(row.iteration_number ?? 1),
    workerHeartbeatAt: parseTimestamp(row.worker_heartbeat_at),
    reclaimCount: Number(row.reclaim_count ?? 0),
  };
}

function rowToSlot(row: TaskRow): TaskSlot {
  const latestTask = rowToTaskRecord(row);
  if (latestTask.slotStatus === "released") {
    throw new Error(`Released task cannot be tracked as an active slot: ${latestTask.id}`);
  }
  return {
    ticketId: latestTask.ticketId,
    slotStatus: latestTask.slotStatus,
    latestTask,
  };
}

function rowToTicketListItem(row: TaskRow): TicketListItem {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    ticketIdentifier: row.ticket_identifier,
    ticketTitle: row.ticket_title,
    ticketDescription: row.ticket_description,
    ticketUrl: row.ticket_url,
    ticketBranchName: row.ticket_branch_name,
    ticketLinearStatusName: row.ticket_linear_status_name,
    ticketLinearStatusType: row.ticket_linear_status_type,
    ticketLabelsJson: row.ticket_labels_json ?? "[]",
    bmStatus: (row.ts_status as BmStatus | null) ?? "in_progress",
    attemptCount: Number(row.attempt_number ?? 0),
    ticketCompletedAt: parseTimestamp(row.ticket_completed_at),
    createdAt: parseTimestampRequired(row.created_at, "created_at"),
    updatedAt: parseTimestampRequired(row.updated_at, "updated_at"),
    latestRun: null,
    latestWorkerName: null,
    latestPr: null,
  };
}

function toLatestRunSummary(row: TaskRow): LatestRunSummary {
  return {
    id: row.id,
    attemptNumber: Number(row.attempt_number ?? 1),
    status: (row.run_status as RunStatus | null),
    trigger: row.trigger ? parseTrigger(row.trigger) : null,
    workerId: row.worker_id,
    stopReason: (row.stop_reason as StopReason | null),
    startedAt: parseTimestamp(row.started_at),
    endedAt: parseTimestamp(row.ended_at),
    createdAt: parseTimestampRequired(row.created_at, "created_at"),
  };
}

function elapsedSince(now: Date, then: Date | null): number | null {
  if (!then) return null;
  return Math.max(0, now.getTime() - then.getTime());
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return DEFAULT_TICKET_PAGE_SIZE;
  return Math.min(Math.floor(value), MAX_TICKET_PAGE_SIZE);
}

function clampPage(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function likeEscape(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Period summary helpers (JS aggregation, ported from repository.ts)
// ---------------------------------------------------------------------------

interface PeriodTaskRow {
  id: string;
  ticket_id: string | null;
  ticket_identifier: string | null;
  ticket_title: string | null;
  ticket_url: string | null;
  ticket_labels_json: string;
  bm_status: string | null;
  attempt_count: number;
  ticket_completed_at: string | null;
  run_status: string | null;
  started_at: string | null;
  ended_at: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model_name: string | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
}

interface PeriodPrRow {
  id: string;
  ticket_id: string | null;
  number: number;
  url: string;
  merged: number | boolean;
  updated_at: string;
}

function inRange(date: Date | null, from: Date, to: Date): boolean {
  return date !== null && date >= from && date < to;
}

function computeThroughput(tasks: PeriodTaskRow[], from: Date, to: Date, maxIterations: number): ThroughputBlock {
  let completed = 0;
  let abandoned = 0;
  let discovered = 0;
  for (const t of tasks) {
    const createdAt = parseTimestamp(t.created_at);
    const completedAt = parseTimestamp(t.ticket_completed_at);
    const updatedAt = parseTimestamp(t.updated_at);
    if (inRange(createdAt, from, to)) discovered += 1;
    if (t.bm_status === "completed" && inRange(completedAt, from, to)) completed += 1;
    else if (Number(t.attempt_count) >= maxIterations && t.bm_status !== "completed" && inRange(updatedAt, from, to)) abandoned += 1;
  }
  return { completed, abandoned, discovered };
}

function computeHealth(tasks: PeriodTaskRow[], from: Date, to: Date, maxIterations: number): HealthBlock {
  let completed = 0;
  let abandoned = 0;
  let attemptsSum = 0;
  let multiAttempt = 0;
  for (const t of tasks) {
    const completedAt = parseTimestamp(t.ticket_completed_at);
    const updatedAt = parseTimestamp(t.updated_at);
    const isCompleted = t.bm_status === "completed" && inRange(completedAt, from, to);
    const isAbandoned = Number(t.attempt_count) >= maxIterations && t.bm_status !== "completed" && inRange(updatedAt, from, to);
    if (!isCompleted && !isAbandoned) continue;
    if (isCompleted) completed += 1;
    else abandoned += 1;
    attemptsSum += Number(t.attempt_count ?? 0);
    if (Number(t.attempt_count ?? 0) > 1) multiAttempt += 1;
  }
  const ticketSettled = completed + abandoned;
  return {
    successRate: ticketSettled > 0 ? completed / ticketSettled : null,
    avgAttempts: ticketSettled > 0 ? attemptsSum / ticketSettled : null,
    multiAttemptRate: ticketSettled > 0 ? multiAttempt / ticketSettled : null,
  };
}

function computeCost(tasks: PeriodTaskRow[], from: Date, to: Date): CostBlock {
  const inWindow = tasks.filter((r) => inRange(parseTimestamp(r.ended_at), from, to));
  let promptTokens = 0;
  let completionTokens = 0;
  const buckets = new Map<string, { provider: string; modelName: string; promptTokens: number; completionTokens: number }>();
  for (const r of inWindow) {
    const p = r.prompt_tokens ?? 0;
    const c = r.completion_tokens ?? 0;
    promptTokens += p;
    completionTokens += c;
    if (r.provider && r.model_name) {
      const key = `${r.provider}::${r.model_name}`;
      const b = buckets.get(key) ?? { provider: r.provider, modelName: r.model_name, promptTokens: 0, completionTokens: 0 };
      b.promptTokens += p;
      b.completionTokens += c;
      buckets.set(key, b);
    }
  }
  const byModel = [...buckets.values()].sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens));
  return { promptTokens, completionTokens, byModel };
}

function computeTime(tasks: PeriodTaskRow[], from: Date, to: Date): TimeBlock {
  const wallClocks: number[] = [];
  let completedCount = 0;
  for (const t of tasks) {
    if (t.bm_status !== "completed") continue;
    const completedAt = parseTimestamp(t.ticket_completed_at);
    if (!inRange(completedAt, from, to)) continue;
    completedCount += 1;
    if (completedAt) {
      const createdAt = parseTimestamp(t.created_at);
      if (createdAt) {
        const seconds = Math.max(0, (completedAt.getTime() - createdAt.getTime()) / 1000);
        wallClocks.push(seconds);
      }
    }
  }
  const avgWallClockSeconds = wallClocks.length > 0 ? wallClocks.reduce((s, n) => s + n, 0) / wallClocks.length : null;
  let totalAgentSeconds = 0;
  for (const r of tasks) {
    const startedAt = parseTimestamp(r.started_at);
    const endedAt = parseTimestamp(r.ended_at);
    if (!startedAt || !endedAt) continue;
    if (!inRange(endedAt, from, to)) continue;
    totalAgentSeconds += Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000);
  }
  return {
    avgWallClockSeconds,
    totalAgentSeconds,
    devHoursSaved: completedCount * DEV_HOURS_PER_TICKET,
  };
}

function repoFromPrUrl(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function computeFailures(
  tasks: PeriodTaskRow[],
  from: Date,
  to: Date,
  maxIterations: number,
): FailureBlock {
  const ticketsAtMaxAttempts: TicketRef[] = tasks
    .filter((t) => Number(t.attempt_count) >= maxIterations && t.bm_status !== "completed" && inRange(parseTimestamp(t.updated_at), from, to))
    .sort((a, b) => (parseTimestamp(b.updated_at)?.getTime() ?? 0) - (parseTimestamp(a.updated_at)?.getTime() ?? 0))
    .slice(0, 20)
    .map((t) => ({ id: t.id, identifier: t.ticket_identifier ?? "", title: t.ticket_title ?? "", url: t.ticket_url ?? "" }));
  return { ticketsAtMaxAttempts };
}

function computeShipped(tasks: PeriodTaskRow[], prs: PeriodPrRow[], from: Date, to: Date): ShippedBlock {
  const completed = tasks.filter((t) => t.bm_status === "completed" && inRange(parseTimestamp(t.ticket_completed_at), from, to));
  const mergedPrByTicket = new Map<string, PeriodPrRow>();
  for (const pr of prs) {
    if (!intBool(pr.merged)) continue;
    const ticketId = pr.ticket_id;
    if (!ticketId) continue;
    const existing = mergedPrByTicket.get(ticketId);
    const prUpdated = parseTimestamp(pr.updated_at);
    const existingUpdated = existing ? parseTimestamp(existing.updated_at) : null;
    if (!existing || (prUpdated && existingUpdated && prUpdated > existingUpdated)) {
      mergedPrByTicket.set(ticketId, pr);
    }
  }
  type RepoBucket = { tickets: ShippedTicket[] };
  const buckets = new Map<string, RepoBucket>();
  for (const t of completed) {
    const pr = t.ticket_id ? mergedPrByTicket.get(t.ticket_id) : null;
    if (!pr) continue;
    const repo = repoFromPrUrl(pr.url) ?? "unknown";
    let labels: string[] = [];
    try {
      const parsed: unknown = JSON.parse(t.ticket_labels_json || "[]");
      if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // Malformed labelsJson — render without labels
    }
    const completedAt = parseTimestamp(t.ticket_completed_at);
    const entry: ShippedTicket = {
      id: t.id,
      identifier: t.ticket_identifier ?? "",
      title: t.ticket_title ?? "",
      url: t.ticket_url ?? "",
      labels,
      prUrl: pr.url,
      prNumber: pr.number,
      completedAt: completedAt?.toISOString() ?? null,
    };
    const b = buckets.get(repo) ?? { tickets: [] };
    b.tickets.push(entry);
    buckets.set(repo, b);
  }
  const byRepo: ShippedRepoBucket[] = [...buckets.entries()]
    .map(([repo, b]) => ({
      repo,
      count: b.tickets.length,
      tickets: b.tickets.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")),
    }))
    .sort((a, b) => b.count - a.count);
  return { byRepo };
}

// ---------------------------------------------------------------------------
// SqlDbClient implementation
// ---------------------------------------------------------------------------

export class SqlDbClient implements DbClient {
  private readonly databaseUrl: string;
  private readonly dialect: DatabaseDialect;
  private readonly maxIterations: number;
  private readonly clock = new MonotonicIsoClock();
  private sqlite: DatabaseSync | null = null;
  private pgPool: pg.Pool | null = null;

  constructor(databaseUrl: string, maxIterations: number) {
    this.databaseUrl = databaseUrl;
    this.dialect = detectDialect(databaseUrl);
    this.maxIterations = maxIterations;
  }

  /** Returns the dialect-appropriate scalar two-argument max function name. */
  private scalarMax(): "MAX" | "GREATEST" {
    return this.dialect === "sqlite" ? "MAX" : "GREATEST";
  }

  /** Rewrite `?` placeholders to `$1, $2, ...` for Postgres. No-op for SQLite. */
  private sql(q: string): string {
    if (this.dialect === "sqlite") return q;
    let i = 0;
    return q.replace(/\?/g, () => `$${++i}`);
  }

  private requireSqlite(): DatabaseSync {
    if (!this.sqlite) throw new Error("DbClient not initialized — call initSchema() first");
    return this.sqlite;
  }

  private requirePg(): pg.Pool {
    if (!this.pgPool) throw new Error("DbClient not initialized — call initSchema() first");
    return this.pgPool;
  }

  private async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.dialect === "sqlite") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return this.requireSqlite().prepare(this.sql(sql)).all(...(params as any[])) as T[];
    }
    const result = await this.requirePg().query(this.sql(sql), params);
    return result.rows as T[];
  }

  private async run(sql: string, params: unknown[]): Promise<{ changes: number }> {
    if (this.dialect === "sqlite") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = this.requireSqlite().prepare(this.sql(sql)).run(...(params as any[]));
      return { changes: Number(result.changes) };
    }
    const result = await this.requirePg().query(this.sql(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  async initSchema(): Promise<void> {
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    const schemaSql = readFileSync(schemaPath, "utf-8");
    // Split on ";" boundaries; keep statements that have at least one non-comment, non-blank line.
    const statements = schemaSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.split("\n").some((line) => line.trim().length > 0 && !line.trim().startsWith("--")));

    if (this.dialect === "sqlite") {
      const path = sqlitePath(this.databaseUrl);
      if (path !== ":memory:") {
        await mkdir(dirname(path), { recursive: true });
      }
      const db = new DatabaseSync(path);
      // SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS.
      // Execute statement by statement and silently ignore duplicate-column errors so the
      // schema is idempotent on both fresh and pre-existing databases.
      for (const stmt of statements) {
        try {
          db.exec(stmt + ";");
        } catch (err) {
          const msg = (err as Error).message ?? "";
          if (!msg.includes("duplicate column name")) throw err;
        }
      }
      this.sqlite = db;
      // Backfill pre-migration tasks into ticket_statuses (no-op if bm_status already dropped).
      // Map old bm_status: 'completed' → 'completed', everything else → 'in_progress'.
      try {
        db.exec(`
          INSERT OR IGNORE INTO ticket_statuses (ticket_id, status, notify, updated_at)
          SELECT DISTINCT ticket_id,
            CASE WHEN bm_status = 'completed' THEN 'completed' ELSE 'in_progress' END,
            0,
            datetime('now')
          FROM tasks WHERE ticket_id IS NOT NULL AND bm_status IS NOT NULL
        `);
        // Drop the now-obsolete column; silently ignored if already removed.
        try { db.exec("ALTER TABLE tasks DROP COLUMN bm_status"); } catch { /* already dropped */ }
      } catch { /* bm_status column already dropped — backfill ran on a prior startup */ }
    } else {
      const pool = new pg.Pool({ connectionString: this.databaseUrl });
      // Execute statement by statement so ALTER TABLE failures on existing columns are
      // swallowed rather than aborting the whole batch (Postgres SQLSTATE 42701).
      const client = await pool.connect();
      try {
        for (const stmt of statements) {
          try {
            await client.query(stmt);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== "42701") throw err; // 42701 = duplicate_column
          }
        }
        // Backfill pre-migration tasks into ticket_statuses (no-op if bm_status already dropped).
        // Map old bm_status: 'completed' → 'completed', everything else → 'in_progress'.
        try {
          await client.query(`
            INSERT INTO ticket_statuses (ticket_id, status, notify, updated_at)
            SELECT DISTINCT ON (ticket_id) ticket_id,
              CASE WHEN bm_status = 'completed' THEN 'completed' ELSE 'in_progress' END,
              0,
              NOW()::TEXT
            FROM tasks WHERE ticket_id IS NOT NULL AND bm_status IS NOT NULL
            ON CONFLICT (ticket_id) DO NOTHING
          `);
          // Drop the now-obsolete column; silently ignored if already removed.
          await client.query(`ALTER TABLE tasks DROP COLUMN IF EXISTS bm_status`);
        } catch { /* bm_status column already dropped — backfill ran on a prior startup */ }
      } finally {
        client.release();
      }
      this.pgPool = pool;
    }
  }

  // -------------------------------------------------------------------------
  // Ticket lifecycle
  // -------------------------------------------------------------------------

  async upsertTicketDiscovered(ticket: TicketInput): Promise<void> {
    const now = this.clock.nowIso();
    // Insert a new row only when no active row exists for this ticket yet.
    // If a row already exists, update the ticket metadata fields on the latest row.
    const existing = await this.query<{ id: string }>(
      `SELECT id FROM tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ticket.id],
    );
    if (existing.length === 0) {
      await this.run(
        `INSERT INTO tasks (id, ticket_id, ticket_identifier, ticket_title, ticket_description,
           ticket_url, ticket_branch_name, ticket_linear_status_name, ticket_linear_status_type,
           ticket_labels_json, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [randomUUID(), ticket.id, ticket.identifier, ticket.title, ticket.description,
         ticket.url, ticket.branchName, ticket.linearStatusName, ticket.linearStatusType,
         JSON.stringify(ticket.labels), now, now],
      );
    } else {
      await this.run(
        `UPDATE tasks SET ticket_identifier = ?, ticket_title = ?, ticket_description = ?,
           ticket_url = ?, ticket_branch_name = ?, ticket_linear_status_name = ?,
           ticket_linear_status_type = ?, ticket_labels_json = ?, updated_at = ?
         WHERE id = ?`,
        [ticket.identifier, ticket.title, ticket.description, ticket.url, ticket.branchName,
         ticket.linearStatusName, ticket.linearStatusType, JSON.stringify(ticket.labels),
         now, existing[0]!.id],
      );
    }
  }

  async setTicketStatus(ticketId: string, status: BmStatus, notify: boolean = false): Promise<void> {
    const now = this.clock.nowIso();
    const notifyInt = notify ? 1 : 0;
    // Only overwrite notify when transitioning TO validating (where it carries the DM flag).
    // For all other status writes (in_progress, waiting_for_human, completed) preserve the
    // existing notify value so a re-dispatch to in_progress cannot silently clear a pending notify=1.
    const fn = this.scalarMax();
    await this.run(
      `INSERT INTO ticket_statuses (ticket_id, status, notify, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (ticket_id) DO UPDATE SET status = excluded.status,
         notify = CASE WHEN excluded.status = 'validating' THEN ${fn}(ticket_statuses.notify, excluded.notify) ELSE ticket_statuses.notify END,
         updated_at = excluded.updated_at`,
      [ticketId, status, notifyInt, now],
    );
    if (status === "completed") {
      // Stamp ticket_completed_at for throughput/health queries that range-filter on it.
      await this.run(
        `UPDATE tasks SET ticket_completed_at = COALESCE(ticket_completed_at, ?), updated_at = ?
         WHERE id = (SELECT id FROM tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)`,
        [now, now, ticketId],
      );
    }
  }

  async readTicketStatus(ticketId: string): Promise<{ status: string; notify: number } | null> {
    const rows = await this.query<{ status: string; notify: number }>(
      `SELECT status, notify FROM ticket_statuses WHERE ticket_id = ?`,
      [ticketId],
    );
    return rows[0] ?? null;
  }

  async tryTransitionToWaitingForHuman(ticketId: string): Promise<boolean> {
    const now = this.clock.nowIso();
    // Atomically flip status + consume notify flag. Affected 1 row means notify was 1.
    const res = await this.run(
      `UPDATE ticket_statuses SET status = 'waiting_for_human', notify = 0, updated_at = ?
       WHERE ticket_id = ? AND status = 'validating' AND notify = 1`,
      [now, ticketId],
    );
    if (res.changes === 1) {
      return true;
    }
    // notify was already 0 — still transition status, just don't DM.
    await this.run(
      `UPDATE ticket_statuses SET status = 'waiting_for_human', updated_at = ?
       WHERE ticket_id = ? AND status = 'validating'`,
      [now, ticketId],
    );
    return false;
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  async upsertRunStarted(taskId: string, workerId: string, workerStartedAt: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE tasks SET run_status = 'running', worker_id = ?, worker_started_at = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?`,
      [workerId, workerStartedAt, now, now, taskId],
    );
  }

  async upsertRunSucceeded(taskId: string, usage: RunUsage | null): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE tasks SET run_status = 'succeeded', stop_reason = 'completed',
         ended_at = ?, prompt_tokens = COALESCE(?, prompt_tokens),
         completion_tokens = COALESCE(?, completion_tokens),
         model_name = COALESCE(?, model_name),
         provider = COALESCE(?, provider),
         updated_at = ?
       WHERE id = ?`,
      [now, usage?.promptTokens ?? null, usage?.completionTokens ?? null,
       usage?.modelName ?? null, usage?.provider ?? null, now, taskId],
    );
  }

  async upsertRunCrashed(taskId: string, error: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE tasks SET run_status = 'crashed', stop_reason = 'crash',
         error = ?, ended_at = ?, updated_at = ?
       WHERE id = ?`,
      [error, now, now, taskId],
    );
  }

  async upsertToolCalls(taskId: string, toolCallsJson: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE tasks SET tool_calls_json = ?, updated_at = ? WHERE id = ?`,
      [toolCallsJson, now, taskId],
    );
  }

  // -------------------------------------------------------------------------
  // PR / CI
  // -------------------------------------------------------------------------

  async upsertPullRequest(id: string, ticketId: string, data: PullRequestInputData): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `INSERT INTO pull_requests (id, ticket_id, number, title, head_ref, state, draft, merged,
         url, last_run_id, review_threads_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ticket_id = excluded.ticket_id,
         number = excluded.number, title = excluded.title, head_ref = excluded.head_ref,
         state = excluded.state, draft = excluded.draft, merged = excluded.merged,
         url = excluded.url, last_run_id = excluded.last_run_id,
         review_threads_json = excluded.review_threads_json,
         updated_at = excluded.updated_at`,
      [id, ticketId, data.number, data.title, data.headRef, data.state,
       data.draft ? 1 : 0, data.merged ? 1 : 0, data.url, data.lastRunId,
       data.reviewThreadsJson, now, now],
    );
  }

  async markPrNotified(prId: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(`UPDATE pull_requests SET notified_at = ? WHERE id = ?`, [now, prId]);
  }

  async getPrNotifiedAt(prId: string): Promise<Date | null> {
    const rows = await this.query<{ notified_at: string | null }>(
      `SELECT notified_at FROM pull_requests WHERE id = ?`,
      [prId],
    );
    return rows.length > 0 ? parseTimestamp(rows[0]!.notified_at) : null;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  async recordEvent(event: EventInput): Promise<void> {
    await this.run(
      `INSERT INTO events (id, ticket_id, run_id, worker_id, source, type, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.ticketId, event.runId, event.workerId, event.source,
       event.type, event.summary, event.payloadJson, event.createdAt],
    );
  }

  // -------------------------------------------------------------------------
  // Task queue — enqueue
  // -------------------------------------------------------------------------

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const now = this.clock.nowIso();
    // Update the existing undispatched row for this ticket if one exists;
    // otherwise insert a new task row (direct dispatch without prior discovery).
    // Use input.ticketIssueId (UUID) as the DB key — ticket_id stores the Linear UUID,
    // not the human-readable identifier (e.g. "ABC-123").
    const existing = await this.query<{ id: string }>(
      `SELECT id FROM tasks WHERE ticket_id = ? AND dispatch_state IS NULL AND result_status IS NULL AND slot_status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.ticketIssueId],
    );

    if (existing.length > 0) {
      const taskId = existing[0]!.id;
      await this.run(
        `UPDATE tasks SET dispatch_state = ?, input_json = ?, trigger = ?,
           attempt_number = (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ? AND id != ?),
           iteration_number = (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ?),
           updated_at = ?
         WHERE id = ?`,
        [input.state, JSON.stringify(input), input.trigger,
         input.ticketIssueId, taskId, input.ticketIssueId, now, taskId],
      );
      const rows = await this.query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
      if (!rows[0]) throw new Error(`Task not found after enqueue update: ${taskId}`);
      return rowToTaskRecord(rows[0]);
    }

    // No discovered row — insert a new one, copying ticket metadata from the most recent
    // existing row so identifier/title remain visible in the UI across iteration re-dispatches.
    const metaRows = await this.query<{
      ticket_identifier: string | null;
      ticket_title: string | null;
      ticket_description: string | null;
      ticket_url: string | null;
      ticket_branch_name: string | null;
      ticket_linear_status_name: string | null;
      ticket_linear_status_type: string | null;
      ticket_labels_json: string | null;
    }>(
      `SELECT ticket_identifier, ticket_title, ticket_description, ticket_url, ticket_branch_name,
              ticket_linear_status_name, ticket_linear_status_type, ticket_labels_json
       FROM tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.ticketIssueId],
    );
    const meta = metaRows[0];
    const id = randomUUID();
    await this.run(
      `INSERT INTO tasks (id, ticket_id, ticket_identifier, ticket_title, ticket_description,
         ticket_url, ticket_branch_name, ticket_linear_status_name, ticket_linear_status_type,
         ticket_labels_json, dispatch_state, attempt_number, input_json,
         trigger, slot_status, created_at, updated_at, iteration_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ?),
         ?, ?, 'active', ?, ?,
         (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ?))`,
      [id, input.ticketIssueId,
       meta?.ticket_identifier ?? null, meta?.ticket_title ?? null,
       meta?.ticket_description ?? null, meta?.ticket_url ?? null,
       meta?.ticket_branch_name ?? null, meta?.ticket_linear_status_name ?? null,
       meta?.ticket_linear_status_type ?? null, meta?.ticket_labels_json ?? "[]",
       input.state, input.ticketIssueId, JSON.stringify(input),
       input.trigger, now, now,
       input.ticketIssueId],
    );
    const rows = await this.query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!rows[0]) throw new Error(`Task not found after insert: ${id}`);
    return rowToTaskRecord(rows[0]);
  }

  // -------------------------------------------------------------------------
  // Task queue — acquireNext (dialect fork)
  // -------------------------------------------------------------------------

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    const now = this.clock.nowIso();

    if (this.dialect === "sqlite") {
      const db = this.requireSqlite();
      db.exec("BEGIN IMMEDIATE");
      try {
        const candidate = db.prepare(`
          SELECT id FROM tasks
          WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
            AND dispatch_state IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        `).get() as { id: string } | undefined;
        if (!candidate) {
          db.exec("COMMIT");
          return null;
        }
        const result = db.prepare(`
          UPDATE tasks SET worker_id = ?, updated_at = ?, worker_heartbeat_at = ?
          WHERE id = ? AND worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
        `).run(workerId, now, now, candidate.id);
        if (result.changes !== 1) {
          throw new Error(`Failed to acquire task: ${candidate.id}`);
        }
        const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(candidate.id) as TaskRow | undefined;
        db.exec("COMMIT");
        if (!row) throw new Error(`Task not found after acquire: ${candidate.id}`);
        return rowToTaskRecord(row);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }

    // Postgres: SELECT ... FOR UPDATE SKIP LOCKED
    const pool = this.requirePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>(
        `
          WITH next_task AS (
            SELECT id FROM tasks
            WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
              AND dispatch_state IS NOT NULL
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE tasks SET worker_id = $1, updated_at = $2, worker_heartbeat_at = $2
          FROM next_task
          WHERE tasks.id = next_task.id
          RETURNING tasks.*
        `,
        [workerId, now],
      );
      await client.query("COMMIT");
      return result.rows[0] ? rowToTaskRecord(result.rows[0]) : null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Task queue — complete
  // -------------------------------------------------------------------------

  async complete(taskId: string, result: DispatchResult): Promise<void> {
    const now = this.clock.nowIso();
    const update = await this.run(
      `UPDATE tasks SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL`,
      [result.status, JSON.stringify(result), now, now, taskId],
    );
    if (update.changes !== 1) {
      throw new Error(`Cannot complete task that is missing, unacquired, or already completed: ${taskId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Task queue — list / count
  // -------------------------------------------------------------------------

  async listTracked(): Promise<TaskSlot[]> {
    if (this.dialect === "sqlite") {
      const rows = await this.query<TaskRow>(`
        SELECT * FROM (
          SELECT tasks.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS row_number
          FROM tasks
        )
        WHERE row_number = 1 AND slot_status != 'released'
        ORDER BY created_at ASC, id ASC
      `);
      return rows.map(rowToSlot);
    }
    // Postgres: DISTINCT ON is more efficient than ROW_NUMBER for this pattern
    const rows = await this.query<TaskRow>(`
      SELECT * FROM (
        SELECT DISTINCT ON (ticket_id) * FROM tasks ORDER BY ticket_id, created_at DESC, id DESC
      ) latest
      WHERE slot_status != 'released'
      ORDER BY created_at ASC, id ASC
    `);
    return rows.map(rowToSlot);
  }

  async countTracked(): Promise<number> {
    if (this.dialect === "sqlite") {
      const rows = await this.query<{ cnt: number }>(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT ticket_id FROM (
            SELECT ticket_id, slot_status,
                   ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS rn
            FROM tasks
          ) WHERE rn = 1 AND slot_status != 'released'
        )
      `);
      return Number(rows[0]?.cnt ?? 0);
    }
    const rows = await this.query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT DISTINCT ON (ticket_id) slot_status
        FROM tasks
        ORDER BY ticket_id, created_at DESC, id DESC
      ) latest WHERE slot_status != 'released'
    `);
    return Number(rows[0]?.cnt ?? 0);
  }

  // -------------------------------------------------------------------------
  // Task queue — setSlotStatus
  // -------------------------------------------------------------------------

  async setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord> {
    const now = this.clock.nowIso();
    if (this.dialect === "sqlite") {
      const latest = await this.query<{ id: string }>(
        `SELECT id FROM tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ticketId],
      );
      if (!latest[0]) throw new Error(`Cannot set slot status for unknown ticket: ${ticketId}`);
      await this.run(
        `UPDATE tasks SET slot_status = ?, released_at = ?, updated_at = ? WHERE id = ?`,
        [status, status === "released" ? now : null, now, latest[0].id],
      );
      const rows = await this.query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [latest[0].id]);
      if (!rows[0]) throw new Error(`Task not found: ${latest[0].id}`);
      return rowToTaskRecord(rows[0]);
    }

    const result = await this.requirePg().query<TaskRow>(
      `
        WITH latest AS (
          SELECT id FROM tasks WHERE ticket_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
        )
        UPDATE tasks SET slot_status = $2, released_at = $3, updated_at = $4
        FROM latest WHERE tasks.id = latest.id
        RETURNING tasks.*
      `,
      [ticketId, status, status === "released" ? now : null, now],
    );
    if (!result.rows[0]) throw new Error(`Cannot set slot status for unknown ticket: ${ticketId}`);
    return rowToTaskRecord(result.rows[0]);
  }

  // -------------------------------------------------------------------------
  // Task queue — iteration count
  // -------------------------------------------------------------------------

  async getIterationCount(ticketId: string): Promise<number> {
    const rows = await this.query<{ count: number | string }>(
      `SELECT COUNT(*) as count FROM tasks WHERE ticket_id = ?`,
      [ticketId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // -------------------------------------------------------------------------
  // Task queue — heartbeat
  // -------------------------------------------------------------------------

  async heartbeat(taskId: string, workerId: string): Promise<boolean> {
    const now = this.clock.nowIso();
    const result = await this.run(
      `UPDATE tasks SET worker_heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND worker_id = ? AND result_status IS NULL`,
      [now, now, taskId, workerId],
    );
    return result.changes === 1;
  }

  // -------------------------------------------------------------------------
  // Task queue — reclaim stale tasks (dialect fork)
  // -------------------------------------------------------------------------

  async reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]> {
    if (this.dialect === "sqlite") {
      const db = this.requireSqlite();
      const threshold = new Date(Date.now() - options.staleAfterMs).toISOString();
      const candidates = db.prepare(`
        SELECT id FROM tasks
        WHERE worker_id IS NOT NULL AND result_status IS NULL
          AND worker_heartbeat_at IS NOT NULL AND worker_heartbeat_at < ?
        ORDER BY worker_heartbeat_at ASC
      `).all(threshold) as Array<{ id: string }>;

      const out: ReclaimResult[] = [];
      for (const candidate of candidates) {
        const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(candidate.id) as TaskRow | undefined;
        if (!row || row.worker_id === null || row.result_status !== null) continue;
        const heartbeat = row.worker_heartbeat_at;
        if (!heartbeat) continue;
        const heartbeatMs = new Date(heartbeat).getTime();
        if (Date.now() - heartbeatMs < options.staleAfterMs) continue;
        const reason = `worker ${row.worker_id} heartbeat stale since ${heartbeat}`;
        out.push(this.sqliteApplyRecovery(db, row, options.maxReclaims, reason));
      }
      return out;
    }

    // Postgres
    const pool = this.requirePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<TaskRow>(
        `
          SELECT * FROM tasks
          WHERE worker_id IS NOT NULL AND result_status IS NULL
            AND worker_heartbeat_at IS NOT NULL
            AND worker_heartbeat_at::timestamptz < (NOW() - ($1::bigint || ' milliseconds')::interval)
          ORDER BY worker_heartbeat_at ASC
          FOR UPDATE SKIP LOCKED
        `,
        [String(options.staleAfterMs)],
      );
      const out: ReclaimResult[] = [];
      for (const row of candidates.rows) {
        if (!row.worker_heartbeat_at) continue;
        const reason = `worker ${row.worker_id} heartbeat stale since ${row.worker_heartbeat_at}`;
        out.push(await this.pgApplyRecovery(client, row, options.maxReclaims, reason));
      }
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Task queue — markCrashed
  // -------------------------------------------------------------------------

  async markCrashed(taskId: string, workerId: string, maxReclaims: number): Promise<ReclaimResult | null> {
    if (this.dialect === "sqlite") {
      const db = this.requireSqlite();
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (!row || row.worker_id !== workerId || row.result_status !== null) return null;
      return this.sqliteApplyRecovery(db, row, maxReclaims, `worker ${workerId} reported crash`);
    }

    const pool = this.requirePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
      const row = result.rows[0];
      if (!row || row.worker_id !== workerId || row.result_status !== null) {
        await client.query("COMMIT");
        return null;
      }
      const recovered = await this.pgApplyRecovery(client, row, maxReclaims, `worker ${workerId} reported crash`);
      await client.query("COMMIT");
      return recovered;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Internal recovery helpers
  // -------------------------------------------------------------------------

  private sqliteApplyRecovery(db: DatabaseSync, row: TaskRow, maxReclaims: number, reason: string): ReclaimResult {
    const now = this.clock.nowIso();
    const previousWorkerId = row.worker_id ?? "unknown";

    if (row.reclaim_count + 1 < maxReclaims) {
      const update = db.prepare(`
        UPDATE tasks SET worker_id = NULL, worker_heartbeat_at = NULL,
          reclaim_count = reclaim_count + 1, updated_at = ?
        WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
      `).run(now, row.id);
      if (update.changes !== 1) {
        throw new Error(`Failed to release stale task ${row.id} for re-acquire`);
      }
      const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id) as TaskRow | undefined;
      if (!updated) throw new Error(`Task not found after reclaim: ${row.id}`);
      return { task: rowToTaskRecord(updated), action: "reclaimed", reason, previousWorkerId };
    }

    const synthetic: DispatchResult = { status: "pending", prs: [] };
    const abandon = db.prepare(`
      UPDATE tasks SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?,
        slot_status = 'released', released_at = ?
      WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
    `).run(synthetic.status, JSON.stringify(synthetic), now, now, now, row.id);
    if (abandon.changes !== 1) {
      throw new Error(`Failed to abandon stale task ${row.id}`);
    }
    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id) as TaskRow | undefined;
    if (!updated) throw new Error(`Task not found after abandon: ${row.id}`);
    return { task: rowToTaskRecord(updated), action: "abandoned", reason, previousWorkerId };
  }

  private async pgApplyRecovery(client: pg.PoolClient, row: TaskRow, maxReclaims: number, reason: string): Promise<ReclaimResult> {
    const now = this.clock.nowIso();
    const previousWorkerId = row.worker_id ?? "unknown";

    if (row.reclaim_count + 1 < maxReclaims) {
      const update = await client.query<TaskRow>(
        `UPDATE tasks SET worker_id = NULL, worker_heartbeat_at = NULL,
           reclaim_count = reclaim_count + 1, updated_at = $1
         WHERE id = $2 AND worker_id IS NOT NULL AND result_status IS NULL
         RETURNING *`,
        [now, row.id],
      );
      if (!update.rows[0]) throw new Error(`Failed to release stale task ${row.id} for re-acquire`);
      return { task: rowToTaskRecord(update.rows[0]), action: "reclaimed", reason, previousWorkerId };
    }

    const synthetic: DispatchResult = { status: "pending", prs: [] };
    const abandon = await client.query<TaskRow>(
      `UPDATE tasks SET result_status = $1, result_json = $2, updated_at = $3, completed_at = $3,
         slot_status = 'released', released_at = $3
       WHERE id = $4 AND worker_id IS NOT NULL AND result_status IS NULL
       RETURNING *`,
      [synthetic.status, JSON.stringify(synthetic), now, row.id],
    );
    if (!abandon.rows[0]) throw new Error(`Failed to abandon stale task ${row.id}`);
    return { task: rowToTaskRecord(abandon.rows[0]), action: "abandoned", reason, previousWorkerId };
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    this.sqlite?.close();
    this.sqlite = null;
    await this.pgPool?.end();
    this.pgPool = null;
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — listTickets
  // -------------------------------------------------------------------------

  async listTickets(options: ListTicketsOptions): Promise<ListTicketsResult> {
    const page = clampPage(options.page);
    const pageSize = clampPageSize(options.pageSize);

    // Build WHERE clause for the ticket (latest task per ticket_id) query
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.bmStatuses && options.bmStatuses.length > 0) {
      const placeholders = options.bmStatuses.map(() => "?").join(", ");
      conditions.push(`COALESCE(ts.status, 'in_progress') IN (${placeholders})`);
      params.push(...options.bmStatuses);
    }

    if (options.createdFrom) {
      conditions.push("created_at >= ?");
      params.push(options.createdFrom.toISOString());
    }
    if (options.createdTo) {
      conditions.push("created_at <= ?");
      params.push(options.createdTo.toISOString());
    }

    if (options.q && options.q.trim().length > 0) {
      const needle = `%${likeEscape(options.q.trim())}%`;
      conditions.push(
        `(ticket_identifier LIKE ? ESCAPE '\\' OR ticket_title LIKE ? ESCAPE '\\'` +
        ` OR ticket_description LIKE ? ESCAPE '\\' OR ticket_branch_name LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle, needle);
    }

    if (options.labels && options.labels.length > 0) {
      const labelClauses = options.labels.map((label) => {
        const jsonEncoded = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const needle = `%"${likeEscape(jsonEncoded)}"%`;
        params.push(needle);
        return `ticket_labels_json LIKE ? ESCAPE '\\'`;
      });
      conditions.push(`(${labelClauses.join(" OR ")})`);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    // Fetch the latest task row per ticket using window function; join ticket_statuses for current status.
    const ticketRows = await this.query<TaskRow>(
      this.sql(`
        SELECT ranked.*, ts.status AS ts_status FROM (
          SELECT tasks.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS rn
          FROM tasks
          WHERE ticket_id IS NOT NULL
        ) ranked
        LEFT JOIN ticket_statuses ts ON ts.ticket_id = ranked.ticket_id
        WHERE rn = 1 ${whereClause}
        ORDER BY ranked.created_at DESC
      `),
      params,
    );

    if (ticketRows.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    const ticketIds = ticketRows.map((r) => r.ticket_id).filter((id): id is string => id !== null);
    const prPlaceholders = ticketIds.map(() => "?").join(", ");

    // Fetch supporting data in parallel
    const prRows = ticketIds.length > 0
      ? await this.query<{ id: string; ticket_id: string; number: number; url: string; state: string; merged: number | boolean; updated_at: string }>(
          this.sql(`SELECT id, ticket_id, number, url, state, merged, updated_at FROM pull_requests WHERE ticket_id IN (${prPlaceholders}) ORDER BY updated_at DESC`),
          ticketIds,
        )
      : [];

    const latestPrByTicket = new Map<string, typeof prRows[number]>();
    for (const pr of prRows) if (pr.ticket_id && !latestPrByTicket.has(pr.ticket_id)) latestPrByTicket.set(pr.ticket_id, pr);

    // Collect distinct worker IDs from task rows that have a worker
    const workerIds = Array.from(new Set(ticketRows.map((r) => r.worker_id).filter((id): id is string => id !== null)));
    let workerNameById = new Map<string, string>();
    if (workerIds.length > 0) {
      // Workers are now stored as tasks rows with a known worker_id and worker_started_at —
      // we derive names from the worker_id field directly (no separate workers table in new schema).
      // Use worker_id as the name fallback.
      for (const wid of workerIds) workerNameById.set(wid, wid);
    }

    const enriched: TicketListItem[] = ticketRows.map((row) => {
      const item = rowToTicketListItem(row);
      item.latestRun = row.run_status !== null ? toLatestRunSummary(row) : null;
      item.latestWorkerName = row.worker_id ? workerNameById.get(row.worker_id) ?? row.worker_id : null;
      const latestPr = row.ticket_id ? latestPrByTicket.get(row.ticket_id) : null;
      item.latestPr = latestPr
        ? { number: latestPr.number, url: latestPr.url, state: latestPr.state, merged: intBool(latestPr.merged) }
        : null;
      return item;
    });

    // JS-side filters (worker, stopReason) that depend on run data
    const workerFilter = options.workerIds && options.workerIds.length > 0 ? new Set(options.workerIds) : null;
    const stopReasonFilter = options.stopReasons && options.stopReasons.length > 0 ? new Set<string>(options.stopReasons) : null;
    const filtered = enriched.filter((row) => {
      if (workerFilter && (row.latestRun?.workerId == null || !workerFilter.has(row.latestRun.workerId))) return false;
      if (stopReasonFilter && (row.latestRun?.stopReason == null || !stopReasonFilter.has(row.latestRun.stopReason))) return false;
      return true;
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return { items: filtered.slice(start, start + pageSize), total, page, pageSize };
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — listTicketFilterOptions
  // -------------------------------------------------------------------------

  async listTicketFilterOptions(): Promise<TicketFilterOptions> {
    const labelRows = await this.query<{ ticket_labels_json: string }>(
      `SELECT DISTINCT ticket_labels_json FROM tasks WHERE ticket_id IS NOT NULL`,
    );
    const labels = new Set<string>();
    for (const { ticket_labels_json } of labelRows) {
      try {
        const parsed: unknown = JSON.parse(ticket_labels_json || "[]");
        if (Array.isArray(parsed)) {
          for (const v of parsed) if (typeof v === "string" && v.length > 0) labels.add(v);
        }
      } catch {
        // malformed — skip
      }
    }

    const stopRows = await this.query<{ stop_reason: string | null }>(
      `SELECT DISTINCT stop_reason FROM tasks WHERE stop_reason IS NOT NULL`,
    );
    const stopReasons = new Set<string>();
    for (const { stop_reason } of stopRows) if (stop_reason) stopReasons.add(stop_reason);

    // Workers: distinct worker_ids from tasks that have started a run
    const workerRows = await this.query<{ worker_id: string }>(
      `SELECT DISTINCT worker_id FROM tasks WHERE worker_id IS NOT NULL AND run_status IS NOT NULL ORDER BY worker_id`,
    );
    const workers = workerRows.map((w) => ({ id: w.worker_id, name: w.worker_id }));

    const allBmStatuses: BmStatus[] = ["in_progress", "validating", "waiting_for_human", "completed"];

    const countRows = await this.query<{ status: string | null; cnt: number }>(
      this.sql(`
        SELECT COALESCE(ts.status, 'in_progress') AS status, COUNT(*) AS cnt
        FROM (
          SELECT ticket_id, MAX(created_at) AS max_ca
          FROM tasks WHERE ticket_id IS NOT NULL
          GROUP BY ticket_id
        ) latest
        JOIN tasks t ON t.ticket_id = latest.ticket_id AND t.created_at = latest.max_ca
        LEFT JOIN ticket_statuses ts ON ts.ticket_id = t.ticket_id
        GROUP BY COALESCE(ts.status, 'in_progress')
      `),
    );
    const statusCounts: Partial<Record<BmStatus, number>> = {};
    for (const row of countRows) {
      if (row.status && allBmStatuses.includes(row.status as BmStatus)) {
        statusCounts[row.status as BmStatus] = Number(row.cnt);
      }
    }

    return {
      bmStatuses: allBmStatuses,
      statusCounts,
      stopReasons: Array.from(stopReasons).sort() as StopReason[],
      labels: Array.from(labels).sort(),
      workers,
    };
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — getTicketDetail
  // -------------------------------------------------------------------------

  async getTicketDetail(id: string): Promise<TicketDetail | null> {
    // id is the ticket_id (Linear issue id)
    const taskRows = await this.query<TaskRow>(
      `SELECT t.*, ts.status AS ts_status
         FROM tasks t
         LEFT JOIN ticket_statuses ts ON ts.ticket_id = t.ticket_id
        WHERE t.ticket_id = ?
        ORDER BY t.created_at ASC`,
      [id],
    );
    if (taskRows.length === 0) return null;

    // Use the latest task row for ticket metadata
    const latestTaskRow = taskRows[taskRows.length - 1]!;
    const ticket = rowToTicketListItem(latestTaskRow);

    // Build RunWithUsage from each task row (each row = one run attempt)
    const runs: RunWithUsage[] = taskRows
      .filter((r) => r.run_status !== null)
      .map((r) => {
        // Parse tool calls from the JSON column
        let toolCalls: RunToolCallRow[] = [];
        if (r.tool_calls_json) {
          try {
            const parsed = JSON.parse(r.tool_calls_json) as unknown;
            if (Array.isArray(parsed)) {
              toolCalls = parsed.map((tc: unknown, idx: number) => {
                const t = tc as Record<string, unknown>;
                return {
                  id: String(t.id ?? `${r.id}:${idx}`),
                  runId: r.id,
                  sequence: Number(t.sequence ?? idx),
                  toolName: String(t.toolName ?? t.tool_name ?? ""),
                  argsJson: String(t.argsJson ?? t.args_json ?? "{}"),
                  resultText: t.resultText != null ? String(t.resultText) : null,
                  resultStatus: t.resultStatus != null ? String(t.resultStatus) : null,
                  outputSize: t.outputSize != null ? Number(t.outputSize) : null,
                  thoughtText: t.thoughtText != null ? String(t.thoughtText) : null,
                  createdAt: parseTimestamp(t.createdAt as string) ?? new Date(),
                };
              });
            }
          } catch {
            // malformed — use empty
          }
        }

        return {
          id: r.id,
          ticketId: r.ticket_id,
          attemptNumber: Number(r.attempt_number ?? 1),
          workerId: r.worker_id,
          trigger: r.trigger ? parseTrigger(r.trigger) : null,
          status: (r.run_status as RunStatus | null),
          startedAt: parseTimestamp(r.started_at),
          endedAt: parseTimestamp(r.ended_at),
          stopReason: (r.stop_reason as StopReason | null),
          error: r.error,
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          modelName: r.model_name,
          provider: r.provider,
          createdAt: parseTimestampRequired(r.created_at, "created_at"),
          worker: r.worker_id ? { id: r.worker_id, name: r.worker_id } : null,
          toolCalls,
        };
      });

    // Pull requests
    const prRows = await this.query<{
      id: string; ticket_id: string; number: number; title: string; head_ref: string;
      state: string; draft: number | boolean; merged: number | boolean; url: string;
      last_run_id: string | null; review_threads_json: string; notified_at: string | null;
      created_at: string; updated_at: string;
    }>(
      `SELECT * FROM pull_requests WHERE ticket_id = ? ORDER BY updated_at DESC`,
      [id],
    );

    const pullRequests: PullRequestWithThreads[] = prRows.map((pr) => {
      let reviewThreads: ReviewThread[] = [];
      try {
        const parsed = JSON.parse(pr.review_threads_json || "[]") as unknown;
        if (Array.isArray(parsed)) {
          reviewThreads = parsed.map((t: unknown) => {
            const thread = t as Record<string, unknown>;
            return {
              id: String(thread.id ?? ""),
              prId: pr.id,
              path: thread.path != null ? String(thread.path) : null,
              line: thread.line != null ? Number(thread.line) : null,
              isResolved: Boolean(thread.isResolved ?? thread.is_resolved),
              commentsJson: String(thread.commentsJson ?? thread.comments_json ?? "[]"),
              createdAt: parseTimestamp(thread.createdAt as string) ?? new Date(),
              updatedAt: parseTimestamp(thread.updatedAt as string) ?? new Date(),
            };
          });
        }
      } catch {
        // malformed — empty threads
      }
      return {
        id: pr.id,
        ticketId: pr.ticket_id,
        number: pr.number,
        title: pr.title,
        headRef: pr.head_ref,
        state: pr.state,
        draft: intBool(pr.draft),
        merged: intBool(pr.merged),
        url: pr.url,
        lastRunId: pr.last_run_id,
        reviewThreadsJson: pr.review_threads_json,
        notifiedAt: parseTimestamp(pr.notified_at),
        createdAt: parseTimestampRequired(pr.created_at, "created_at"),
        updatedAt: parseTimestampRequired(pr.updated_at, "updated_at"),
        reviewThreads,
      };
    });

    // Events
    const eventRows = await this.query<{
      id: string; ticket_id: string | null; run_id: string | null; worker_id: string | null;
      source: string; type: string; summary: string; payload_json: string | null; created_at: string;
    }>(
      `SELECT * FROM events WHERE ticket_id = ? ORDER BY created_at ASC`,
      [id],
    );
    const events = eventRows.map((e) => ({
      id: e.id,
      ticketId: e.ticket_id,
      runId: e.run_id,
      workerId: e.worker_id,
      source: e.source,
      type: e.type,
      summary: e.summary,
      payloadJson: e.payload_json,
      createdAt: parseTimestampRequired(e.created_at, "created_at"),
    }));

    return { ticket, runs, pullRequests, events };
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — listWorkers
  // -------------------------------------------------------------------------

  async listWorkers(): Promise<WorkerListItem[]> {
    const now = new Date();
    // Workers are identified by distinct worker_ids that have active or recent task rows
    type WorkerRow = {
      worker_id: string;
      id: string;
      ticket_id: string | null;
      ticket_identifier: string | null;
      ticket_title: string | null;
      run_status: string | null;
      trigger: string | null;
      worker_id_val: string | null;
      stop_reason: string | null;
      started_at: string | null;
      ended_at: string | null;
      attempt_number: number;
      created_at: string;
      updated_at: string;
      worker_heartbeat_at: string | null;
      worker_started_at: string | null;
    };
    const SELECT_WORKER_COLS = `worker_id, id, ticket_id, ticket_identifier, ticket_title,
      run_status, trigger, worker_id AS worker_id_val, stop_reason, started_at, ended_at,
      attempt_number, created_at, updated_at, worker_heartbeat_at, worker_started_at`;
    let workerRows: WorkerRow[];
    if (this.dialect === "sqlite") {
      workerRows = await this.query<WorkerRow>(`
        SELECT ${SELECT_WORKER_COLS}
        FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY worker_id ORDER BY updated_at DESC) AS rn
          FROM tasks
          WHERE worker_id IS NOT NULL
        )
        WHERE rn = 1
      `);
    } else {
      workerRows = await this.query<WorkerRow>(`
        SELECT DISTINCT ON (worker_id) ${SELECT_WORKER_COLS}
        FROM tasks
        WHERE worker_id IS NOT NULL
        ORDER BY worker_id, updated_at DESC
      `);
    }

    return workerRows.map((w) => {
      const heartbeatAt = parseTimestamp(w.worker_heartbeat_at);
      const heartbeatAgeMs = elapsedSince(now, heartbeatAt);
      const startedAt = parseTimestamp(w.started_at);
      const endedAt = parseTimestamp(w.ended_at);
      const runtimeMs = endedAt ? elapsedSince(endedAt, startedAt) : elapsedSince(now, startedAt);
      const isTimedOut = w.run_status === "running" && runtimeMs !== null && endedAt === null && runtimeMs >= WORKER_RUN_TIMEOUT_MS;

      let currentRun: CurrentRunSummary | null = null;
      if (w.ticket_id && w.run_status) {
        currentRun = {
          id: w.id,
          attemptNumber: Number(w.attempt_number ?? 1),
          status: (w.run_status as RunStatus | null),
          trigger: w.trigger ? parseTrigger(w.trigger) : null,
          workerId: w.worker_id,
          stopReason: (w.stop_reason as StopReason | null),
          startedAt,
          endedAt,
          createdAt: parseTimestampRequired(w.created_at, "created_at"),
          ticketId: w.ticket_id,
          ticketIdentifier: w.ticket_identifier ?? "",
          ticketTitle: w.ticket_title ?? "",
          runtimeMs,
        };
      }

      const isActive = w.run_status === "running" || w.run_status === "dispatched";
      const status: WorkerStatus = isActive ? "busy" : "idle";
      return {
        id: w.worker_id,
        name: w.worker_id,
        status,
        currentRunId: isActive ? w.id : null,
        lastHeartbeatAt: w.worker_heartbeat_at,
        startedAt: w.worker_started_at ?? w.updated_at,
        updatedAt: w.updated_at,
        currentTicketIdentifier: w.ticket_identifier,
        currentTicketTitle: w.ticket_title,
        currentRun,
        heartbeatAgeMs,
        isDead: false,
        isHeartbeatStale: heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS,
        isTimedOut,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — listModelComparison
  // -------------------------------------------------------------------------

  async listModelComparison(): Promise<ModelComparisonRow[]> {
    const rows = await this.query<{
      run_status: string | null;
      model_name: string | null;
      provider: string | null;
      started_at: string | null;
      ended_at: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
    }>(
      `SELECT run_status, model_name, provider, started_at, ended_at, prompt_tokens, completion_tokens
       FROM tasks
       WHERE model_name IS NOT NULL AND provider IS NOT NULL`,
    );

    const buckets = new Map<string, {
      provider: string; modelName: string; totalRuns: number; succeededRuns: number;
      durations: number[]; promptTokens: number; completionTokens: number;
    }>();

    for (const r of rows) {
      const provider = r.provider ?? "";
      const modelName = r.model_name ?? "";
      if (!provider || !modelName) continue;
      const key = `${provider}::${modelName}`;
      let b = buckets.get(key);
      if (!b) {
        b = { provider, modelName, totalRuns: 0, succeededRuns: 0, durations: [], promptTokens: 0, completionTokens: 0 };
        buckets.set(key, b);
      }
      b.totalRuns += 1;
      if (r.run_status === "succeeded") b.succeededRuns += 1;
      const startedAt = parseTimestamp(r.started_at);
      const endedAt = parseTimestamp(r.ended_at);
      if (startedAt && endedAt) {
        b.durations.push(Math.max(0, (endedAt.getTime() - startedAt.getTime()) / 1000));
      }
      b.promptTokens += r.prompt_tokens ?? 0;
      b.completionTokens += r.completion_tokens ?? 0;
    }

    const result: ModelComparisonRow[] = [];
    for (const b of buckets.values()) {
      const avgDuration = b.durations.length > 0 ? b.durations.reduce((s, n) => s + n, 0) / b.durations.length : null;
      result.push({
        family: modelFamily(b.provider, b.modelName),
        provider: b.provider,
        modelName: b.modelName,
        totalRuns: b.totalRuns,
        succeededRuns: b.succeededRuns,
        successRate: b.totalRuns > 0 ? b.succeededRuns / b.totalRuns : 0,
        avgDurationSeconds: avgDuration,
        runsWithDuration: b.durations.length,
        totalPromptTokens: b.promptTokens,
        totalCompletionTokens: b.completionTokens,
      });
    }
    result.sort((a, b) => (b.totalPromptTokens + b.totalCompletionTokens) - (a.totalPromptTokens + a.totalCompletionTokens));
    return result;
  }

  // -------------------------------------------------------------------------
  // Dashboard reads — getPeriodSummary
  // -------------------------------------------------------------------------

  async getPeriodSummary({ from, to }: PeriodSummaryOptions): Promise<PeriodSummary> {
    const durationMs = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - durationMs);
    const priorTo = from;
    const outerFrom = priorFrom;
    const outerTo = to;

    // Fetch all relevant data in parallel; bound to outerFrom–outerTo to cover both current and prior windows
    const [allTasks, allPrs] = await Promise.all([
      this.query<PeriodTaskRow>(
        `SELECT t.id, t.ticket_id, t.ticket_identifier, t.ticket_title, t.ticket_url, t.ticket_labels_json,
           ts.status AS bm_status, t.attempt_count, t.ticket_completed_at,
           t.run_status, t.started_at, t.ended_at, t.prompt_tokens, t.completion_tokens,
           t.model_name, t.provider, t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN ticket_statuses ts ON ts.ticket_id = t.ticket_id
         WHERE t.created_at >= ? AND t.created_at < ?`,
        [outerFrom.toISOString(), outerTo.toISOString()],
      ),
      this.query<PeriodPrRow>(
        `SELECT id, ticket_id, number, url, merged, updated_at FROM pull_requests
         WHERE created_at >= ? AND created_at < ?`,
        [outerFrom.toISOString(), outerTo.toISOString()],
      ),
    ]);

    const throughput = computeThroughput(allTasks, from, to, this.maxIterations);
    const throughputPrior = computeThroughput(allTasks, priorFrom, priorTo, this.maxIterations);
    const health = computeHealth(allTasks, from, to, this.maxIterations);
    const healthPrior = computeHealth(allTasks, priorFrom, priorTo, this.maxIterations);
    const cost = computeCost(allTasks, from, to);
    const costPrior = computeCost(allTasks, priorFrom, priorTo);
    const time = computeTime(allTasks, from, to);
    const timePrior = computeTime(allTasks, priorFrom, priorTo);
    const failures = computeFailures(allTasks, from, to, this.maxIterations);
    const shipped = computeShipped(allTasks, allPrs, from, to);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      prior: { from: priorFrom.toISOString(), to: priorTo.toISOString() },
      throughput: { ...throughput, prior: throughputPrior },
      health: { ...health, prior: healthPrior },
      cost: { ...cost, prior: costPrior },
      time: { ...time, prior: timePrior },
      failures,
      shipped,
    };
  }

  // -------------------------------------------------------------------------
  // Comment store
  // -------------------------------------------------------------------------

  async markCompleted(pr: PullRequestRef, commentId: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `INSERT INTO completed_issue_comments (owner, repo, pr_number, comment_id, completed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [pr.owner, pr.repo, pr.number, commentId, now],
    );
  }

  async getCompleted(pr: PullRequestRef): Promise<Set<string>> {
    const rows = await this.query<{ comment_id: string }>(
      `SELECT comment_id FROM completed_issue_comments WHERE owner = ? AND repo = ? AND pr_number = ?`,
      [pr.owner, pr.repo, pr.number],
    );
    return new Set(rows.map((r) => r.comment_id));
  }
}
