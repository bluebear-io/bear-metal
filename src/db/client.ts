import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

export type DatabaseDialect = "sqlite" | "postgres";
export function detectDialect(databaseUrl: string): DatabaseDialect {
  if (databaseUrl.startsWith("sqlite:")) return "sqlite";
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) return "postgres";
  throw new Error(`Unsupported database URL scheme: ${databaseUrl}`);
}
function modelFamily(provider: string | null, modelName: string | null): "claude" | "gpt" | "gemini" | "other" {
  const p = (provider ?? "").toLowerCase();
  const m = (modelName ?? "").toLowerCase();
  if (p === "anthropic" || m.includes("claude")) return "claude";
  if (p === "openai" || m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("o4")) return "gpt";
  if (p === "google" || m.includes("gemini")) return "gemini";
  return "other";
}

export type BmStatus = "in_progress" | "validating" | "waiting_for_human" | "failed" | "completed";

export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunTrigger = "new" | "ci_failure" | "delegated_back" | "merge_conflict";
export type StopReason = "completed" | "deferred" | "timeout" | "crash" | "error";

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
  task_type: string;
  slack_workspace_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  slack_source_ts: string | null;
  slack_source_user_id: string | null;
  slack_request_index: number | null;
  slack_request: string | null;
  slack_quote: string | null;
  slack_delegate_to_bear_metal: number | null;
  slack_state: string | null;
  slack_reply_ts: string | null;
  slack_ack_state: string | null;
  coordinated_at: string | null;
  superseded_by: string | null;
  slack_replaces_task_id: string | null;
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

export interface SlackThreadKey {
  workspaceId: string;
  channelId: string;
  threadTs: string;
}

export interface SlackCoordinationReply {
  sourceTs: string;
  requestIndex: number;
  text: string;
  taskId?: string;
  direct?: boolean;
  kind?: "answer" | "clarification" | "task_ack" | "task_cancel";
}

export type SlackReplyDelivery = SlackCoordinationReply & { state: "queued" | "posting" | "posted" };

export function slackReplyKey(reply: SlackCoordinationReply): string {
  const kind = reply.kind ?? (reply.direct ? "answer" : reply.taskId ? "task_ack" : "clarification");
  if (kind === "task_cancel") {
    if (!reply.taskId) throw new Error("Cancellation reply requires a task ID");
    return `${reply.sourceTs}/task_cancel/${reply.taskId}`;
  }
  return `${reply.sourceTs}/${kind}/${reply.requestIndex}`;
}

export interface AgentRunSummary {
  id: string;
  type: string;
  status: string;
  slackState: string | null;
  slackQuote: string | null;
  slackReplyTs: string | null;
  attemptNumber: number;
  workerId: string | null;
  stopReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  contextJson: string | null;
  inputJson: string | null;
  ticketId: string | null;
  ticketIdentifier: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  slackWorkspaceId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackSourceTs: string | null;
  request: string | null;
  resultJson: string | null;
  error: string | null;
  provider: string | null;
  modelName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface AgentTraceEvent {
  id: string;
  runId: string;
  kind: string;
  contentJson: string;
  createdAt: string;
}

export interface TaskListItem {
  id: string;
  type: "coding" | "research" | "coordinator";
  ticketId: string | null;
  identifier: string | null;
  title: string;
  ticketUrl: string | null;
  status: string;
  runStatus: string | null;
  attemptCount: number;
  workerId: string | null;
  assigneeName: string | null;
  updatedAt: string;
  createdAt: string;
  pullRequests: TicketListPullRequest[];
}

export interface TaskListOptions {
  q?: string;
  type?: TaskListItem["type"];
  statuses?: string[];
  workerId?: string;
  label?: string;
  stopReason?: StopReason;
  page: number;
  pageSize: number;
}

function rowToAgentRun(row: TaskRow): AgentRunSummary {
  return {
    id: row.id, type: row.task_type, status: row.run_status ?? row.slack_state ?? row.dispatch_state ?? "queued",
    slackState: row.slack_state,
    slackQuote: row.slack_quote, slackReplyTs: row.slack_reply_ts,
    attemptNumber: row.attempt_number, workerId: row.worker_id, stopReason: row.stop_reason,
    promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
    contextJson: row.context_json, inputJson: row.input_json,
    ticketId: row.ticket_id, ticketIdentifier: row.ticket_identifier, ticketTitle: row.ticket_title,
    ticketUrl: row.ticket_url, slackWorkspaceId: row.slack_workspace_id,
    slackChannelId: row.slack_channel_id, slackThreadTs: row.slack_thread_ts,
    slackSourceTs: row.slack_source_ts, request: row.slack_request,
    resultJson: row.result_json, error: row.error, provider: row.provider, modelName: row.model_name,
    startedAt: row.started_at, endedAt: row.ended_at, createdAt: row.created_at,
  };
}

export interface SlackUnsubscribeReaction {
  sourceTs: string;
  messageTs: string;
  state: "queued" | "posted" | "failed";
  error: string | null;
}

export interface SlackMessageEdit {
  ts: string;
  originalTs: string;
  user: string;
  text: string;
}

export interface SlackTaskRecord {
  id: string;
  type: "coding" | "research";
  thread: SlackThreadKey;
  sourceTs: string;
  sourceUserId: string | null;
  requestIndex: number;
  request: string;
  quote: string | null;
  delegateToBearMetal: boolean | null;
  state: "queued" | "running" | "awaiting_coordination" | "approved" | "posting" | "coordinated" | "canceled" | "failed";
  result: string | null;
  summary: string | null;
  ticketId: string | null;
  ticketUrl: string | null;
  replyTs: string | null;
  ackState: "posting" | "posted" | "failed" | null;
  coordinatedAt: string | null;
  supersededBy: string | null;
  replacesTaskId: string | null;
}

export interface NewSlackTask {
  replacesTaskId?: string;
  type: SlackTaskRecord["type"];
  thread: SlackThreadKey;
  sourceTs: string;
  sourceUserId?: string;
  requestIndex: number;
  request: string;
  quote?: string;
  delegateToBearMetal?: boolean;
}

function rowToSlackTask(row: TaskRow): SlackTaskRecord {
  if (row.task_type !== "coding" && row.task_type !== "research") throw new Error(`Invalid Slack task type: ${row.task_type}`);
  if (!row.slack_workspace_id || !row.slack_channel_id || !row.slack_thread_ts || !row.slack_source_ts || !row.slack_request_index || !row.slack_request) {
    throw new Error(`Slack task ${row.id} has missing source fields`);
  }
  if (row.slack_state !== "queued" && row.slack_state !== "running" && row.slack_state !== "awaiting_coordination" && row.slack_state !== "approved" && row.slack_state !== "posting" && row.slack_state !== "coordinated" && row.slack_state !== "canceled" && row.slack_state !== "failed") {
    throw new Error(`Invalid Slack task state for ${row.id}: ${row.slack_state}`);
  }
  if (row.slack_ack_state !== null && row.slack_ack_state !== "posting" && row.slack_ack_state !== "posted" && row.slack_ack_state !== "failed") throw new Error(`Invalid Slack acknowledgment state for ${row.id}: ${row.slack_ack_state}`);
  if (row.task_type === "coding" && row.slack_delegate_to_bear_metal !== 0 && row.slack_delegate_to_bear_metal !== 1) throw new Error(`Coding task ${row.id} has no valid delegation choice`);
  let result: string | null = null;
  let summary: string | null = null;
  if (row.result_json !== null && row.task_type === "coding") {
    try {
      validateStoredDispatchResult(row.result_json);
    } catch (err) {
      throw new Error(`Coding task ${row.id} has an invalid result: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  if (row.result_json !== null && row.task_type === "research") {
    let parsed: { answer?: unknown; summary?: unknown };
    try {
      parsed = JSON.parse(row.result_json) as { answer?: unknown; summary?: unknown };
    } catch (err) {
      throw new Error(`Research task ${row.id} has an invalid result: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`Research task ${row.id} has an invalid result`);
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()) throw new Error(`Research task ${row.id} has an invalid result`);
    if (parsed.summary !== undefined && (typeof parsed.summary !== "string" || !parsed.summary.trim())) throw new Error(`Research task ${row.id} has an invalid summary`);
    result = parsed.answer;
    summary = parsed.summary ?? null;
  }
  return {
    id: row.id,
    type: row.task_type,
    thread: { workspaceId: row.slack_workspace_id, channelId: row.slack_channel_id, threadTs: row.slack_thread_ts },
    sourceTs: row.slack_source_ts,
    sourceUserId: row.slack_source_user_id,
    requestIndex: row.slack_request_index,
    request: row.slack_request,
    quote: row.slack_quote,
    delegateToBearMetal: row.slack_delegate_to_bear_metal === null ? null : row.slack_delegate_to_bear_metal === 1,
    state: row.slack_state,
    result,
    summary,
    ticketId: row.ticket_id,
    ticketUrl: row.ticket_url,
    replyTs: row.slack_reply_ts,
    ackState: row.slack_ack_state,
    coordinatedAt: row.coordinated_at,
    supersededBy: row.superseded_by,
    replacesTaskId: row.slack_replaces_task_id,
  };
}

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

export interface StaleWaitingForHumanRow {
  ticketId: string;
  latestTask: TaskRecord;
}

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

export interface TicketListPullRequest {
  id: string;
  number: number;
  title: string;
  headRef: string;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
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
  pullRequests: TicketListPullRequest[];
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
  resultStatus: string | null;
  createdAt: Date;
}

export interface ToolCallDetail {
  argsJson: string;
  resultText: string | null;
  outputSize: number | null;
  thoughtText: string | null;
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

export interface DbClient {
  initSchema(): Promise<void>;
  startAgentRun(task: { id: string; type: "coding" | "coordinator" | "research"; request?: string; slack?: SlackThreadKey & { sourceTs: string } }, provider: string | null, model: string | null): Promise<void>;
  setAgentRunModel(id: string, provider: string, model: string): Promise<void>;
  setAgentRunUsage(id: string, promptTokens: number, completionTokens: number): Promise<void>;
  finishAgentRun(id: string, error: string | null, stopReason?: "deferred", outputJson?: string): Promise<void>;
  recordAgentTrace(runId: string, kind: string, contentJson: string, createdAt?: string): Promise<void>;
  purgeAgentTraces(retentionDays: number, now?: Date): Promise<void>;
  listAgentRuns(page: number, pageSize: number): Promise<{ items: AgentRunSummary[]; total: number; page: number; pageSize: number }>;
  listTasks(options: TaskListOptions): Promise<{ items: TaskListItem[]; total: number; page: number; pageSize: number }>;
  getAgentRunDetail(id: string): Promise<{ run: AgentRunSummary; trace: AgentTraceEvent[] } | null>;
  followSlackThread(key: SlackThreadKey, firstMessageTs: string, directMessage?: boolean): Promise<void>;
  getSlackThreadActivation(key: SlackThreadKey): Promise<{ directMessage: boolean; mentionTimestamps: string[] }>;
  queueSlackCoordinationReply(key: SlackThreadKey, reply: SlackCoordinationReply): Promise<SlackReplyDelivery>;
  listSlackCoordinationReplies(key: SlackThreadKey, sourceTs: string[]): Promise<SlackReplyDelivery[]>;
  beginSlackReplyGroup(key: SlackThreadKey, replies: SlackCoordinationReply[]): Promise<string>;
  finishSlackReplyGroup(key: SlackThreadKey, groupKey: string, outcome: "posted" | "rejected" | "uncertain", replyTs: string | null, error: string | null): Promise<void>;
  unsubscribeSlackThread(key: SlackThreadKey, sourceTs: string): Promise<void>;
  suspendSlackChannel(workspaceId: string, channelId: string): Promise<void>;
  listSlackUnsubscribeReactions(key: SlackThreadKey, includeCompleted?: boolean): Promise<SlackUnsubscribeReaction[]>;
  markSlackUnsubscribeReactionPosted(key: SlackThreadKey, sourceTs: string): Promise<void>;
  failSlackUnsubscribeReaction(key: SlackThreadKey, sourceTs: string, error: string, permanent: boolean): Promise<void>;
  isSlackThreadFollowing(key: SlackThreadKey, sourceTs?: string): Promise<boolean>;
  hasSlackThread(key: SlackThreadKey): Promise<boolean>;
  recordSlackMessage(key: SlackThreadKey, messageTs: string): Promise<boolean>;
  recordSlackEdit(key: SlackThreadKey, eventTs: string, originalTs: string, user: string, text: string): Promise<boolean>;
  abandonSlackDeletedMessage(workspaceId: string, channelId: string, deletedTs: string): Promise<SlackThreadKey[]>;
  listSlackPendingEdits(key: SlackThreadKey): Promise<SlackMessageEdit[]>;
  listSlackPendingThreads(): Promise<SlackThreadKey[]>;
  listSlackPendingMessages(key: SlackThreadKey): Promise<string[]>;
  markSlackMessagesProcessed(key: SlackThreadKey, messageTs: string[]): Promise<void>;
  createSlackTask(input: NewSlackTask): Promise<{ task: SlackTaskRecord; created: boolean }>;
  getSlackTask(id: string): Promise<SlackTaskRecord | null>;
  listSlackThreadTasks(key: SlackThreadKey): Promise<SlackTaskRecord[]>;
  claimSlackResearchTask(): Promise<SlackTaskRecord | null>;
  recoverSlackResearchTasks(): Promise<void>;
  completeSlackResearchTask(id: string, answer: string, summary?: string): Promise<SlackTaskRecord | null>;
  approveSlackResearchResult(id: string): Promise<void>;
  failSlackTask(id: string, error: string): Promise<void>;
  attachSlackTicket(id: string, ticketId: string, ticketUrl: string): Promise<void>;
  hasSlackLinkedTicket(ticketIssueId: string): Promise<boolean>;
  resumeSlackTicketReplacement(id: string): Promise<void>;
  cancelSlackTask(id: string, supersededBy?: string): Promise<void>;
  beginSlackTaskReply(id: string): Promise<void>;
  beginSlackBatchAcknowledgment(ids: string[]): Promise<void>;
  failSlackBatchAcknowledgment(ids: string[], error: string): Promise<void>;
  markSlackResearchStartedReply(id: string, replyTs: string): Promise<void>;
  markSlackTaskCoordinated(id: string, replyTs?: string): Promise<void>;

  upsertTicketDiscovered(ticket: TicketInput): Promise<void>;
  setTicketStatus(ticketId: string, status: BmStatus, notify?: boolean): Promise<void>;
  /** Returns the current status and notify flag for a ticket, or null if no row exists. For diagnostics only. */
  readTicketStatus(ticketId: string): Promise<{ status: string; notify: number } | null>;
  /** Transitions a validating ticket to waiting_for_human, but only while `completedTaskId` is still the
   *  ticket's latest tracked task and is completed. Does not clear the notify flag: returns true while a
   *  PR notification is pending for that task, including after an earlier send failed or was skipped. */
  tryTransitionToWaitingForHuman(ticketId: string, completedTaskId: string): Promise<boolean>;
  /** Clears the pending notify flag after Slack accepted the notification for `completedTaskId`. Leaves it
   *  set when a newer task for the ticket has already completed, so that task's intent survives. */
  clearPendingNotification(ticketId: string, completedTaskId: string): Promise<void>;
  /** Atomically claims the PR notification sends for `taskId`. A PR is claimable when no claim exists or the
   *  previous claim is still `sending` and older than `leaseMs` (its owner crashed). Returns the claimed PR ids
   *  and the token that owns them; PRs already delivered or being sent by another owner are not claimed. */
  claimPrNotifications(taskId: string, prIds: string[], leaseMs: number): Promise<{ claimToken: string; claimed: string[] }>;
  markPrNotificationDelivered(taskId: string, prId: string): Promise<void>;
  /** Drops a `sending` claim still owned by `claimToken` so a later poll can retry the send. */
  releasePrNotificationClaim(taskId: string, prId: string, claimToken: string): Promise<void>;
  listDeliveredPrNotifications(taskId: string): Promise<Set<string>>;

  upsertRunStarted(taskId: string, workerId: string, workerStartedAt: string): Promise<void>;
  upsertRunSucceeded(taskId: string, usage: RunUsage | null): Promise<void>;
  upsertRunCrashed(taskId: string, error: string, lease: { workerId: string | null; reclaimCount: number; abandoned?: boolean }): Promise<boolean>;
  upsertToolCalls(taskId: string, toolCallsJson: string): Promise<void>;

  upsertPullRequest(id: string, ticketId: string, data: PullRequestInputData): Promise<void>;
  markPrNotified(prId: string): Promise<void>;
  getPrNotifiedAt(prId: string): Promise<Date | null>;

  recordEvent(event: EventInput): Promise<void>;

  markCompleted(pr: PullRequestRef, commentId: string): Promise<void>;
  getCompleted(pr: PullRequestRef): Promise<Set<string>>;

  enqueue(input: DispatchTaskInput): Promise<TaskRecord>;
  acquireNext(workerId: string): Promise<TaskRecord | null>;
  complete(taskId: string, result: DispatchResult, workerId?: string, reclaimCount?: number): Promise<void>;
  listTracked(): Promise<TaskSlot[]>;
  /** Current latest tracked task for one ticket, or null if its slot is released. */
  getTrackedSlot(ticketId: string): Promise<TaskSlot | null>;
  /** Latest task row per ticket where ticket_statuses.status = 'waiting_for_human' AND slot_status = 'released'.
   *  These rows are invisible to listTracked() and so never get terminal-state reconciliation through the normal refresh loop. */
  listStaleWaitingForHuman(): Promise<StaleWaitingForHumanRow[]>;
  /** Linear ticket ids whose ticket_statuses.status is 'waiting_for_human' — used to exclude them from new-task admission. */
  listWaitingForHumanTicketIds(): Promise<string[]>;
  countTracked(): Promise<number>;
  setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord>;
  getIterationCount(ticketId: string): Promise<number>;
  heartbeat(taskId: string, workerId: string, reclaimCount?: number): Promise<boolean>;
  reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]>;
  markCrashed(taskId: string, workerId: string, maxReclaims: number, reclaimCount?: number): Promise<ReclaimResult | null>;
  close(): Promise<void>;

  listTickets(options: ListTicketsOptions): Promise<ListTicketsResult>;
  listTicketFilterOptions(): Promise<TicketFilterOptions>;
  getTicketDetail(id: string): Promise<TicketDetail | null>;
  getToolCallDetail(runId: string, sequence: number): Promise<ToolCallDetail | null>;
  getEventPayload(eventId: string): Promise<string | null>;
  listWorkers(): Promise<WorkerListItem[]>;
  listModelComparison(): Promise<ModelComparisonRow[]>;
  getPeriodSummary(options: PeriodSummaryOptions): Promise<PeriodSummary>;
}

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const WORKER_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEV_HOURS_PER_TICKET = 4;
// ---------------------------------------------------------------------------
// Monotonic ISO clock — prevents duplicate timestamps across rapid writes
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

function sqlitePath(databaseUrl: string): string {
  const path = databaseUrl.slice("sqlite:".length);
  if (!path) throw new Error("SQLite database URL must include a file path");
  return path;
}

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

// Stricter than parseDispatchResult: a stored coding outcome must be a complete payload as written by
// complete() or crash recovery. Legacy single `pr` payloads (object or null) are still accepted when `prs` is absent.
function validateStoredDispatchResult(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`result_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("result_json must be an object");
  const result = parsed as Record<string, unknown>;
  if (result.status !== "pending" && result.status !== "done") throw new Error(`Invalid dispatch result status: ${String(result.status)}`);
  if (result.notifyOnComplete !== undefined && typeof result.notifyOnComplete !== "boolean") throw new Error("notifyOnComplete must be a boolean");
  if (result.prs !== undefined) {
    if (!Array.isArray(result.prs)) throw new Error("prs must be an array");
    result.prs.forEach((item) => validateStoredPullRequestRef(item));
  } else if (result.pr !== undefined) {
    if (result.pr !== null) validateStoredPullRequestRef(result.pr);
  } else {
    throw new Error("result_json is missing prs");
  }
}

function validateStoredPullRequestRef(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("PullRequestRef must be an object");
  const ref = value as Record<string, unknown>;
  if (typeof ref.owner !== "string" || !ref.owner.trim()) throw new Error("PullRequestRef owner must be a non-empty string");
  if (typeof ref.repo !== "string" || !ref.repo.trim()) throw new Error("PullRequestRef repo must be a non-empty string");
  if (typeof ref.number !== "number" || !Number.isInteger(ref.number) || ref.number <= 0) throw new Error("PullRequestRef number must be a positive integer");
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

function rowToStaleWaitingForHumanRow(row: TaskRow): StaleWaitingForHumanRow {
  const latestTask = rowToTaskRecord(row);
  if (latestTask.ticketId === null) {
    throw new Error(`Stale waiting_for_human row has no ticket_id: ${latestTask.id}`);
  }
  return { ticketId: latestTask.ticketId, latestTask };
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
    pullRequests: [],
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

  private scalarMax(): "MAX" | "GREATEST" {
    return this.dialect === "sqlite" ? "MAX" : "GREATEST";
  }

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
      db.exec("PRAGMA busy_timeout = 1000");
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

  async startAgentRun(task: { id: string; type: "coding" | "coordinator" | "research"; request?: string; slack?: SlackThreadKey & { sourceTs: string } }, provider: string | null, model: string | null): Promise<void> {
    if (task.type === "coding") throw new Error("startAgentRun is only for coordinator and research tasks");
    const now = this.clock.nowIso();
    if (task.type === "coordinator") {
      if (!task.slack) throw new Error("Coordinator run requires Slack source");
      await this.run(
        `INSERT INTO tasks (id, task_type, slack_workspace_id, slack_channel_id, slack_thread_ts,
         slack_source_ts, slack_request, input_json, run_status, trigger, started_at, provider, model_name, created_at, updated_at)
         VALUES (?, 'coordinator', ?, ?, ?, ?, ?, ?, 'running', 'new', ?, ?, ?, ?, ?)`,
        [task.id, task.slack.workspaceId, task.slack.channelId, task.slack.threadTs,
          task.slack.sourceTs, "Slack thread coordination", task.request ?? null, now, provider, model, now, now],
      );
      return;
    }
    const result = await this.run(
      `UPDATE tasks SET run_status = 'running', started_at = ?, ended_at = NULL, stop_reason = NULL, error = NULL,
       provider = ?, model_name = ?, updated_at = ? WHERE id = ? AND task_type = 'research' AND slack_state = 'running'`,
      [now, provider, model, now, task.id],
    );
    if (result.changes !== 1) throw new Error(`Research run ${task.id} does not exist`);
  }

  async setAgentRunModel(id: string, provider: string, model: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET provider = ?, model_name = ?, updated_at = ?
       WHERE id = ? AND task_type IN ('coordinator', 'research') AND run_status = 'running'`,
      [provider, model, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot set model for agent run ${id}`);
  }

  async setAgentRunUsage(id: string, promptTokens: number, completionTokens: number): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET prompt_tokens = ?, completion_tokens = ?, updated_at = ?
       WHERE id = ? AND task_type IN ('coordinator', 'research') AND run_status = 'running'`,
      [promptTokens, completionTokens, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot record usage for agent run ${id}`);
  }

  async finishAgentRun(id: string, error: string | null, stopReason?: "deferred", outputJson?: string): Promise<void> {
    const now = this.clock.nowIso();
    const result = await this.run(
      `UPDATE tasks SET run_status = ?, stop_reason = ?, error = ?, ended_at = ?, updated_at = ?,
         result_json = CASE WHEN task_type = 'coordinator' THEN ? ELSE result_json END
       WHERE id = ? AND task_type IN ('coordinator', 'research')`,
      [error === null ? "succeeded" : "failed", error === null ? stopReason ?? "completed" : "error", error, now, now, outputJson ?? null, id],
    );
    if (result.changes !== 1) throw new Error(`Agent run ${id} does not exist`);
  }

  async recordAgentTrace(runId: string, kind: string, contentJson: string, createdAt = this.clock.nowIso()): Promise<void> {
    await this.run(
      `INSERT INTO agent_trace_events (id, run_id, kind, content_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), runId, kind, contentJson, createdAt],
    );
  }

  async purgeAgentTraces(retentionDays: number, now = new Date()): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Trace retention must be a positive number of days");
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    await this.run(`DELETE FROM agent_trace_events WHERE created_at < ?`, [cutoff]);
    await this.run(`UPDATE tasks SET tool_calls_json = NULL WHERE tool_calls_json IS NOT NULL AND ended_at < ?`, [cutoff]);
    await this.run(`UPDATE events SET payload_json = NULL WHERE type = 'agent_started' AND payload_json IS NOT NULL AND created_at < ?`, [cutoff]);
  }

  async listAgentRuns(page: number, pageSize: number): Promise<{ items: AgentRunSummary[]; total: number; page: number; pageSize: number }> {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("Invalid agent run page or page size");
    }
    const filter = `task_type IN ('coordinator', 'research') OR run_status IS NOT NULL`;
    const count = await this.query<{ total: number | string }>(`SELECT COUNT(*) AS total FROM tasks WHERE ${filter}`);
    const rows = await this.query<TaskRow>(this.sql(
      `SELECT * FROM tasks WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ), [pageSize, (page - 1) * pageSize]);
    return { items: rows.map(rowToAgentRun), total: Number(count[0]?.total ?? 0), page, pageSize };
  }

  async listTasks(options: TaskListOptions): Promise<{ items: TaskListItem[]; total: number; page: number; pageSize: number }> {
    const { page, pageSize } = options;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_TICKET_PAGE_SIZE) {
      throw new Error("Invalid task page or page size");
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.type) { conditions.push("task_type = ?"); params.push(options.type); }
    if (options.statuses?.length) {
      conditions.push(`task_status IN (${options.statuses.map(() => "?").join(", ")})`);
      params.push(...options.statuses);
    }
    if (options.q?.trim()) {
      const needle = `%${likeEscape(options.q.trim())}%`;
      conditions.push(`(COALESCE(ticket_identifier, '') LIKE ? ESCAPE '\\' OR COALESCE(ticket_title, '') LIKE ? ESCAPE '\\'
        OR COALESCE(ticket_description, '') LIKE ? ESCAPE '\\' OR COALESCE(ticket_branch_name, '') LIKE ? ESCAPE '\\'
        OR COALESCE(slack_request, '') LIKE ? ESCAPE '\\')`);
      params.push(needle, needle, needle, needle, needle);
    }
    if (options.workerId) { conditions.push("worker_id = ?"); params.push(options.workerId); }
    if (options.label) {
      const jsonEncoded = options.label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      conditions.push(`ticket_labels_json LIKE ? ESCAPE '\\'`);
      params.push(`%"${likeEscape(jsonEncoded)}"%`);
    }
    if (options.stopReason) { conditions.push("stop_reason = ?"); params.push(options.stopReason); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const feed = `WITH ranked AS (
      SELECT t.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS ticket_rank
      FROM tasks t
    ), task_feed AS (
      SELECT ranked.*, CASE
        WHEN task_type = 'coding' AND ranked.ticket_id IS NULL THEN COALESCE(slack_state, run_status, 'queued')
        WHEN task_type = 'coding' THEN COALESCE(ts.status, 'in_progress')
        WHEN task_type = 'research' THEN COALESCE(slack_state, run_status, 'queued')
        ELSE COALESCE(run_status, 'queued') END AS task_status
      FROM ranked LEFT JOIN ticket_statuses ts ON ts.ticket_id = ranked.ticket_id
      WHERE (ranked.task_type = 'coding' AND (ranked.ticket_id IS NULL OR ticket_rank = 1))
         OR (ranked.task_type IN ('research', 'coordinator') AND ranked.ticket_id IS NULL)
    )`;
    const count = await this.query<{ total: number | string }>(this.sql(`${feed} SELECT COUNT(*) AS total FROM task_feed ${where}`), params);
    const rows = await this.query<TaskRow & { task_status: string }>(
      this.sql(`${feed} SELECT * FROM task_feed ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`),
      [...params, pageSize, (page - 1) * pageSize],
    );
    const ticketIds = rows.map((row) => row.ticket_id).filter((id): id is string => id !== null);
    const pullRequests = ticketIds.length ? await this.query<{
      id: string; ticket_id: string; number: number; title: string; head_ref: string; url: string;
      state: string; draft: number | boolean; merged: number | boolean;
    }>(this.sql(`SELECT id, ticket_id, number, title, head_ref, url, state, draft, merged FROM pull_requests
      WHERE ticket_id IN (${ticketIds.map(() => "?").join(", ")}) ORDER BY updated_at DESC`), ticketIds) : [];
    const prsByTicket = new Map<string, TicketListPullRequest[]>();
    for (const pr of pullRequests) {
      const entries = prsByTicket.get(pr.ticket_id) ?? [];
      entries.push({ id: pr.id, number: pr.number, title: pr.title, headRef: pr.head_ref, url: pr.url,
        state: pr.state, draft: intBool(pr.draft), merged: intBool(pr.merged) });
      prsByTicket.set(pr.ticket_id, entries);
    }
    const items: TaskListItem[] = rows.map((row) => {
      if (row.task_type !== "coding" && row.task_type !== "research" && row.task_type !== "coordinator") {
        throw new Error(`Unexpected task type ${row.task_type}`);
      }
      return {
        id: row.ticket_id ?? row.id, type: row.task_type, ticketId: row.ticket_id,
        identifier: row.ticket_identifier, title: row.ticket_title ?? row.slack_request ?? "Slack thread coordination",
        ticketUrl: row.ticket_url, status: row.task_status, runStatus: row.run_status,
        attemptCount: Number(row.attempt_number), workerId: row.worker_id, assigneeName: null,
        updatedAt: row.updated_at, createdAt: row.created_at,
        pullRequests: row.ticket_id ? prsByTicket.get(row.ticket_id) ?? [] : [],
      };
    });
    return { items, total: Number(count[0]?.total ?? 0), page, pageSize };
  }

  async getAgentRunDetail(id: string): Promise<{ run: AgentRunSummary; trace: AgentTraceEvent[] } | null> {
    const rows = await this.query<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, [id]);
    if (!rows[0]) return null;
    const trace = await this.query<{ id: string; run_id: string; kind: string; content_json: string; created_at: string }>(
      `SELECT * FROM agent_trace_events WHERE run_id = ? ORDER BY created_at ASC, id ASC`, [id],
    );
    const events: AgentTraceEvent[] = trace.map((event) => ({
      id: event.id, runId: event.run_id, kind: event.kind, contentJson: event.content_json, createdAt: event.created_at,
    }));
    if (events.length === 0 && rows[0].tool_calls_json) {
      const legacy = JSON.parse(rows[0].tool_calls_json) as unknown;
      if (!Array.isArray(legacy)) throw new Error(`tool_calls_json for task ${id} is not an array`);
      for (const [index, value] of legacy.entries()) {
        const call = value as Record<string, unknown>;
        const createdAt = typeof call.createdAt === "number"
          ? new Date(call.createdAt)
          : new Date(String(call.createdAt));
        if (Number.isNaN(createdAt.getTime())) throw new Error(`Invalid tool call timestamp for task ${id}`);
        events.push({
          id: String(call.id ?? `${id}:${index}`), runId: id, kind: "tool_call",
          contentJson: JSON.stringify({ toolName: call.toolName, argsJson: call.argsJson,
            resultText: call.resultText, resultStatus: call.resultStatus, thoughtText: call.thoughtText }),
          createdAt: createdAt.toISOString(),
        });
      }
    }
    return { run: rowToAgentRun(rows[0]), trace: events };
  }

  async followSlackThread(key: SlackThreadKey, firstMessageTs: string, directMessage = false): Promise<void> {
    await this.run(
      `INSERT INTO slack_thread_mentions (workspace_id, channel_id, thread_ts, message_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, channel_id, thread_ts, message_ts) DO NOTHING`,
      [key.workspaceId, key.channelId, key.threadTs, firstMessageTs],
    );
    await this.run(
      `INSERT INTO slack_threads (workspace_id, channel_id, thread_ts, first_message_ts, created_at, latest_mention_ts, direct_message)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, channel_id, thread_ts) DO UPDATE
       SET following = 1, first_message_ts = CASE WHEN slack_threads.following = 0 OR excluded.first_message_ts < slack_threads.first_message_ts
         THEN excluded.first_message_ts ELSE slack_threads.first_message_ts END,
         direct_message = CASE WHEN excluded.direct_message = 1 THEN 1 ELSE slack_threads.direct_message END,
         latest_mention_ts = CASE WHEN excluded.latest_mention_ts > slack_threads.latest_mention_ts
           THEN excluded.latest_mention_ts ELSE slack_threads.latest_mention_ts END
       WHERE slack_threads.unsubscribed_message_ts IS NULL
         OR excluded.first_message_ts > slack_threads.unsubscribed_message_ts`,
      [key.workspaceId, key.channelId, key.threadTs, firstMessageTs, this.clock.nowIso(), firstMessageTs, directMessage ? 1 : 0],
    );
  }

  async getSlackThreadActivation(key: SlackThreadKey): Promise<{ directMessage: boolean; mentionTimestamps: string[] }> {
    const threads = await this.query<{ direct_message: number }>(
      `SELECT direct_message FROM slack_threads WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    if (!threads[0] || ![0, 1].includes(threads[0].direct_message)) throw new Error(`Invalid Slack thread activation ${key.channelId}/${key.threadTs}`);
    const mentions = await this.query<{ message_ts: string }>(
      `SELECT message_ts FROM slack_thread_mentions WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? ORDER BY message_ts`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    return { directMessage: threads[0].direct_message === 1, mentionTimestamps: mentions.map((mention) => mention.message_ts) };
  }

  async queueSlackCoordinationReply(key: SlackThreadKey, reply: SlackCoordinationReply): Promise<SlackReplyDelivery> {
    if (!reply.sourceTs || !Number.isInteger(reply.requestIndex) || reply.requestIndex < 1 || !reply.text.trim()) throw new Error("Invalid Slack coordination reply");
    const now = this.clock.nowIso();
    const kind = reply.kind ?? (reply.direct ? "answer" : reply.taskId ? "task_ack" : "clarification");
    const replyKey = slackReplyKey(reply);
    await this.run(
      `INSERT INTO slack_reply_deliveries (workspace_id, channel_id, thread_ts, reply_key, source_ts, request_index, reply_text, reply_kind, task_id, direct, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM slack_threads
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?
       ON CONFLICT (workspace_id, channel_id, thread_ts, reply_key) DO NOTHING`,
      [key.workspaceId, key.channelId, key.threadTs, replyKey, reply.sourceTs, reply.requestIndex, reply.text, kind, reply.taskId ?? null, reply.direct ? 1 : 0, now, now, key.workspaceId, key.channelId, key.threadTs],
    );
    const rows = await this.query<{ request_index: number; reply_text: string; task_id: string | null; direct: number; state: "queued" | "posting" | "posted" }>(
      `SELECT request_index, reply_text, task_id, direct, state FROM slack_reply_deliveries WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND reply_key = ?`,
      [key.workspaceId, key.channelId, key.threadTs, replyKey],
    );
    const saved = rows[0];
    if (!saved) throw new Error(`Cannot queue reply for unknown Slack thread ${key.channelId}/${key.threadTs}`);
    if (saved.task_id !== (reply.taskId ?? null) || saved.direct !== (reply.direct ? 1 : 0)) throw new Error(`Conflicting reply kind ${reply.sourceTs}/${reply.requestIndex}`);
    return { sourceTs: reply.sourceTs, requestIndex: saved.request_index, text: saved.reply_text, kind, ...(saved.task_id ? { taskId: saved.task_id } : {}), direct: saved.direct === 1, state: saved.state };
  }

  async listSlackCoordinationReplies(key: SlackThreadKey, sourceTs: string[]): Promise<SlackReplyDelivery[]> {
    if (sourceTs.length === 0) return [];
    const rows = await this.query<{
      source_ts: string; request_index: number; reply_text: string; task_id: string | null;
      direct: number; reply_kind: NonNullable<SlackCoordinationReply["kind"]>; state: SlackReplyDelivery["state"];
    }>(
      `SELECT source_ts, request_index, reply_text, task_id, direct, reply_kind, state FROM slack_reply_deliveries
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND source_ts IN (${sourceTs.map(() => "?").join(",")})
       ORDER BY source_ts, request_index, reply_key`,
      [key.workspaceId, key.channelId, key.threadTs, ...sourceTs],
    );
    return rows.map((row) => ({ sourceTs: row.source_ts, requestIndex: row.request_index, text: row.reply_text,
      kind: row.reply_kind, ...(row.task_id ? { taskId: row.task_id } : {}), direct: row.direct === 1, state: row.state }));
  }

  async beginSlackReplyGroup(key: SlackThreadKey, replies: SlackCoordinationReply[]): Promise<string> {
    const members = replies.map(slackReplyKey).sort();
    if (members.length === 0 || new Set(members).size !== members.length) throw new Error("Reply group requires distinct members");
    const groupKey = JSON.stringify(members);
    const predicate = `reply_key IN (${members.map(() => "?").join(",")})`;
    const params = [key.workspaceId, key.channelId, key.threadTs, ...members];
    const result = await this.run(
      `UPDATE slack_reply_deliveries SET state = 'posting', group_key = ?, error = NULL, updated_at = ?
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND (${predicate}) AND state = 'queued'
       AND (SELECT COUNT(*) FROM slack_reply_deliveries WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND (${predicate}) AND state = 'queued') = ?`,
      [groupKey, this.clock.nowIso(), ...params, ...params, members.length],
    );
    if (result.changes !== members.length) throw new Error(`Cannot begin Slack reply group ${groupKey}`);
    return groupKey;
  }

  async finishSlackReplyGroup(key: SlackThreadKey, groupKey: string, outcome: "posted" | "rejected" | "uncertain", replyTs: string | null, error: string | null): Promise<void> {
    if (outcome === "posted" ? !replyTs || error !== null : replyTs !== null || !error) throw new Error("Invalid reply group outcome");
    const result = await this.run(
      `UPDATE slack_reply_deliveries SET state = ?, reply_ts = ?, error = ?, updated_at = ?
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND group_key = ? AND state = 'posting'`,
      [outcome === "posted" ? "posted" : outcome === "rejected" ? "queued" : "posting", replyTs, error, this.clock.nowIso(), key.workspaceId, key.channelId, key.threadTs, groupKey],
    );
    if (result.changes === 0) throw new Error(`Cannot finish Slack reply group ${groupKey}`);
  }

  async unsubscribeSlackThread(key: SlackThreadKey, sourceTs: string): Promise<void> {
    const nextMention = `(SELECT MIN(message_ts) FROM slack_thread_mentions mention WHERE mention.workspace_id = slack_threads.workspace_id
      AND mention.channel_id = slack_threads.channel_id AND mention.thread_ts = slack_threads.thread_ts AND mention.message_ts > ?)`;
    const update = `UPDATE slack_threads SET following = CASE WHEN ${nextMention} IS NULL THEN 0 ELSE 1 END,
         first_message_ts = COALESCE(${nextMention}, first_message_ts), unsubscribed_message_ts = ?
         WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?`;
    const params = [sourceTs, sourceTs, sourceTs, key.workspaceId, key.channelId, key.threadTs];
    const insert = `INSERT INTO slack_unsubscribe_reactions (workspace_id, channel_id, thread_ts, source_ts, message_ts)
      SELECT workspace_id, channel_id, thread_ts, message_ts, COALESCE(original_message_ts, message_ts)
      FROM slack_processed_messages WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND message_ts = ?
      ON CONFLICT (workspace_id, channel_id, thread_ts, source_ts) DO NOTHING`;
    const reactionParams = [key.workspaceId, key.channelId, key.threadTs, sourceTs];
    // Persist the acknowledgement atomically with unsubscription, even when following ends.
    if (this.dialect === "sqlite") {
      const db = this.requireSqlite();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare(update).run(...params).changes !== 1) throw new Error("Cannot unsubscribe unknown Slack thread");
        db.prepare(insert).run(...reactionParams);
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
      return;
    }
    const client = await this.requirePg().connect();
    try {
      await client.query("BEGIN");
      if ((await client.query(this.sql(update), params)).rowCount !== 1) throw new Error("Cannot unsubscribe unknown Slack thread");
      await client.query(this.sql(insert), reactionParams);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  }

  async listSlackUnsubscribeReactions(key: SlackThreadKey, includeCompleted = false): Promise<SlackUnsubscribeReaction[]> {
    const rows = await this.query<{ source_ts: string; message_ts: string; state: SlackUnsubscribeReaction["state"]; error: string | null }>(
      `SELECT source_ts, message_ts, state, error FROM slack_unsubscribe_reactions WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND (state = 'queued' OR ? = 1) ORDER BY source_ts`,
      [key.workspaceId, key.channelId, key.threadTs, Number(includeCompleted)],
    );
    return rows.map((row) => ({ sourceTs: row.source_ts, messageTs: row.message_ts, state: row.state, error: row.error }));
  }

  async markSlackUnsubscribeReactionPosted(key: SlackThreadKey, sourceTs: string): Promise<void> {
    const result = await this.run(`UPDATE slack_unsubscribe_reactions SET posted = 1, state = 'posted', error = NULL WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND source_ts = ? AND state = 'queued'`,
      [key.workspaceId, key.channelId, key.threadTs, sourceTs]);
    if (result.changes !== 1) throw new Error("Cannot finish unsubscribe reaction delivery");
  }

  async failSlackUnsubscribeReaction(key: SlackThreadKey, sourceTs: string, error: string, permanent: boolean): Promise<void> {
    if (!error.trim()) throw new Error("Reaction delivery failure requires an error");
    const result = await this.run(
      `UPDATE slack_unsubscribe_reactions SET state = ?, error = ? WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND source_ts = ? AND state = 'queued'`,
      [permanent ? "failed" : "queued", error, key.workspaceId, key.channelId, key.threadTs, sourceTs],
    );
    if (result.changes !== 1) throw new Error("Cannot record unsubscribe reaction failure");
  }

  async isSlackThreadFollowing(key: SlackThreadKey, sourceTs?: string): Promise<boolean> {
    const rows = await this.query<{ following: number; first_message_ts: string; unsubscribed_message_ts: string | null }>(
      `SELECT following, first_message_ts, unsubscribed_message_ts FROM slack_threads WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ?`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    const thread = rows[0];
    if (!thread || thread.following === 0) return false;
    if (thread.following !== 1) throw new Error(`Invalid following state for Slack thread ${key.channelId}/${key.threadTs}`);
    if (sourceTs === undefined) return true;
    return sourceTs >= thread.first_message_ts && (thread.unsubscribed_message_ts === null || sourceTs > thread.unsubscribed_message_ts);
  }

  async hasSlackThread(key: SlackThreadKey): Promise<boolean> {
    const rows = await this.query<{ first_message_ts: string }>(
      `SELECT thread.first_message_ts FROM slack_threads thread
       JOIN slack_processed_messages activation ON activation.workspace_id = thread.workspace_id
         AND activation.channel_id = thread.channel_id AND activation.thread_ts = thread.thread_ts
         AND activation.message_ts = thread.first_message_ts
       WHERE thread.workspace_id = ? AND thread.channel_id = ? AND thread.thread_ts = ? AND thread.following = 1`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    return rows.length > 0;
  }

  async recordSlackMessage(key: SlackThreadKey, messageTs: string): Promise<boolean> {
    const result = await this.run(
      `INSERT INTO slack_processed_messages (workspace_id, channel_id, message_ts, thread_ts, created_at)
       SELECT ?, ?, ?, ?, ? FROM slack_threads
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND following = 1 AND first_message_ts <= ?
       ON CONFLICT (workspace_id, channel_id, message_ts) DO NOTHING`,
      [key.workspaceId, key.channelId, messageTs, key.threadTs, this.clock.nowIso(),
        key.workspaceId, key.channelId, key.threadTs, messageTs],
    );
    return result.changes === 1;
  }

  async recordSlackEdit(key: SlackThreadKey, eventTs: string, originalTs: string, user: string, text: string): Promise<boolean> {
    const result = await this.run(
      `INSERT INTO slack_processed_messages (workspace_id, channel_id, message_ts, thread_ts, original_message_ts, edited_user, edited_text, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM slack_threads
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND following = 1 AND first_message_ts <= ?
       ON CONFLICT (workspace_id, channel_id, message_ts) DO NOTHING`,
      [key.workspaceId, key.channelId, eventTs, key.threadTs, originalTs, user, text, this.clock.nowIso(),
        key.workspaceId, key.channelId, key.threadTs, originalTs],
    );
    return result.changes === 1;
  }

  async abandonSlackDeletedMessage(workspaceId: string, channelId: string, deletedTs: string): Promise<SlackThreadKey[]> {
    const rows = await this.query<{ thread_ts: string }>(
      `SELECT DISTINCT thread_ts FROM slack_processed_messages
       WHERE workspace_id = ? AND channel_id = ? AND processed_at IS NULL
         AND (message_ts = ? OR original_message_ts = ?)`,
      [workspaceId, channelId, deletedTs, deletedTs],
    );
    await this.run(
      `UPDATE slack_processed_messages SET processed_at = ?
       WHERE workspace_id = ? AND channel_id = ? AND processed_at IS NULL
         AND (message_ts = ? OR original_message_ts = ?)`,
      [this.clock.nowIso(), workspaceId, channelId, deletedTs, deletedTs],
    );
    return rows.map((row) => ({ workspaceId, channelId, threadTs: row.thread_ts }));
  }

  async listSlackPendingEdits(key: SlackThreadKey): Promise<SlackMessageEdit[]> {
    const rows = await this.query<{ message_ts: string; original_message_ts: string; edited_user: string | null; edited_text: string | null }>(
      `SELECT message_ts, original_message_ts, edited_user, edited_text FROM slack_processed_messages
       WHERE workspace_id = ? AND channel_id = ? AND thread_ts = ? AND processed_at IS NULL AND original_message_ts IS NOT NULL`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    return rows.map((row) => {
      if (!row.edited_user || row.edited_text === null) throw new Error(`Slack edit ${row.message_ts} is missing user or text`);
      return { ts: row.message_ts, originalTs: row.original_message_ts, user: row.edited_user, text: row.edited_text };
    });
  }

  async suspendSlackChannel(workspaceId: string, channelId: string): Promise<void> {
    if (!workspaceId || !channelId) throw new Error("Slack channel suspension requires workspace and channel IDs");
    await this.run(`UPDATE slack_threads SET following = 0 WHERE workspace_id = ? AND channel_id = ?`, [workspaceId, channelId]);
  }

  async listSlackPendingThreads(): Promise<SlackThreadKey[]> {
    const rows = await this.query<{ workspace_id: string; channel_id: string; thread_ts: string }>(
      `SELECT DISTINCT message.workspace_id, message.channel_id, message.thread_ts
       FROM slack_processed_messages message
       JOIN slack_threads thread ON thread.workspace_id = message.workspace_id
         AND thread.channel_id = message.channel_id AND thread.thread_ts = message.thread_ts
       JOIN slack_processed_messages activation ON activation.workspace_id = thread.workspace_id
         AND activation.channel_id = thread.channel_id AND activation.thread_ts = thread.thread_ts
         AND activation.message_ts = thread.first_message_ts
       WHERE thread.following = 1 AND message.processed_at IS NULL AND message.message_ts >= thread.first_message_ts
         AND (thread.unsubscribed_message_ts IS NULL OR message.message_ts > thread.unsubscribed_message_ts)
       UNION SELECT DISTINCT slack_workspace_id AS workspace_id, slack_channel_id AS channel_id, slack_thread_ts AS thread_ts
       FROM tasks JOIN slack_threads thread ON thread.workspace_id = tasks.slack_workspace_id
         AND thread.channel_id = tasks.slack_channel_id AND thread.thread_ts = tasks.slack_thread_ts
       WHERE thread.following = 1 AND tasks.slack_source_ts >= thread.first_message_ts
         AND (thread.unsubscribed_message_ts IS NULL OR tasks.slack_source_ts > thread.unsubscribed_message_ts) AND task_type IN ('coding', 'research') AND (
         (slack_state = 'awaiting_coordination' AND task_type = 'research') OR
         slack_state = 'approved' OR
         (slack_ack_state IS NULL AND slack_state = 'awaiting_coordination' AND task_type = 'coding') OR
         (slack_ack_state IS NULL AND task_type = 'research' AND slack_state IN ('queued', 'running')) OR
         (slack_ack_state IS NULL AND slack_state = 'canceled' AND coordinated_at IS NULL AND superseded_by IS NULL)
       )
       UNION SELECT workspace_id, channel_id, thread_ts FROM slack_unsubscribe_reactions WHERE state = 'queued'`,
    );
    return rows.map((row) => {
      if (!row.workspace_id || !row.channel_id || !row.thread_ts) throw new Error("Pending Slack thread has missing identity");
      return { workspaceId: row.workspace_id, channelId: row.channel_id, threadTs: row.thread_ts };
    });
  }

  async listSlackPendingMessages(key: SlackThreadKey): Promise<string[]> {
    const rows = await this.query<{ message_ts: string }>(
      `SELECT message.message_ts FROM slack_processed_messages message
       JOIN slack_threads thread ON thread.workspace_id = message.workspace_id
         AND thread.channel_id = message.channel_id AND thread.thread_ts = message.thread_ts
       WHERE message.workspace_id = ? AND message.channel_id = ? AND message.thread_ts = ?
         AND thread.following = 1 AND message.processed_at IS NULL AND message.message_ts >= thread.first_message_ts
         AND (thread.unsubscribed_message_ts IS NULL OR message.message_ts > thread.unsubscribed_message_ts)
       ORDER BY message.message_ts ASC`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    return rows.map((row) => row.message_ts);
  }

  async markSlackMessagesProcessed(key: SlackThreadKey, messageTs: string[]): Promise<void> {
    for (const ts of messageTs) {
      const result = await this.run(
        `UPDATE slack_processed_messages SET processed_at = ? WHERE workspace_id = ? AND channel_id = ? AND message_ts = ? AND thread_ts = ? AND processed_at IS NULL`,
        [this.clock.nowIso(), key.workspaceId, key.channelId, ts, key.threadTs],
      );
      if (result.changes !== 1) throw new Error(`Cannot mark Slack message processed: ${key.channelId}/${ts}`);
    }
  }

  async createSlackTask(input: NewSlackTask): Promise<{ task: SlackTaskRecord; created: boolean }> {
    if (!input.request.trim() || !Number.isInteger(input.requestIndex) || input.requestIndex < 1) {
      throw new Error("Slack task requires a request and positive request index");
    }
    if (input.type === "coding" && typeof input.delegateToBearMetal !== "boolean") throw new Error("Coding task requires an explicit delegation choice");
    if (input.type === "research" && input.delegateToBearMetal !== undefined) throw new Error("Research tasks cannot specify coding delegation");
    if (input.type === "research" && !input.quote?.trim()) throw new Error("Research task requires an identifying question quote");
    const id = randomUUID();
    const now = this.clock.nowIso();
    const result = await this.run(
      `INSERT INTO tasks (id, task_type, slack_workspace_id, slack_channel_id, slack_thread_ts,
       slack_source_ts, slack_source_user_id, slack_request_index, slack_request, slack_quote, slack_delegate_to_bear_metal, slack_replaces_task_id, slack_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
       ON CONFLICT (slack_workspace_id, slack_channel_id, slack_source_ts, slack_request_index) DO NOTHING`,
      [id, input.type, input.thread.workspaceId, input.thread.channelId, input.thread.threadTs,
        input.sourceTs, input.sourceUserId ?? null, input.requestIndex, input.request, input.quote ?? null, input.type === "coding" ? Number(input.delegateToBearMetal) : null, input.replacesTaskId ?? null, now, now],
    );
    const rows = await this.query<TaskRow>(
      `SELECT * FROM tasks WHERE slack_workspace_id = ? AND slack_channel_id = ? AND slack_source_ts = ? AND slack_request_index = ?`,
      [input.thread.workspaceId, input.thread.channelId, input.sourceTs, input.requestIndex],
    );
    if (!rows[0]) throw new Error("Slack task disappeared after insertion");
    if (input.replacesTaskId !== undefined && rows[0].slack_replaces_task_id !== input.replacesTaskId) throw new Error("Conflicting replacement original task");
    if (rows[0].id === rows[0].slack_replaces_task_id) throw new Error("Cannot replace a task with itself");
    return { task: rowToSlackTask(rows[0]), created: result.changes === 1 };
  }

  async getSlackTask(id: string): Promise<SlackTaskRecord | null> {
    const rows = await this.query<TaskRow>(`SELECT * FROM tasks WHERE id = ? AND slack_workspace_id IS NOT NULL`, [id]);
    return rows[0] ? rowToSlackTask(rows[0]) : null;
  }

  async listSlackThreadTasks(key: SlackThreadKey): Promise<SlackTaskRecord[]> {
    const rows = await this.query<TaskRow>(
      `SELECT * FROM tasks WHERE slack_workspace_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       AND task_type IN ('coding', 'research') ORDER BY created_at ASC, id ASC`,
      [key.workspaceId, key.channelId, key.threadTs],
    );
    return rows.map(rowToSlackTask);
  }

  async claimSlackResearchTask(): Promise<SlackTaskRecord | null> {
    const rows = await this.query<TaskRow>(
      `SELECT * FROM tasks WHERE task_type = 'research' AND slack_state = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    if (!rows[0]) return null;
    const result = await this.run(
      `UPDATE tasks SET slack_state = 'running', updated_at = ? WHERE id = ? AND slack_state = 'queued'`,
      [this.clock.nowIso(), rows[0].id],
    );
    if (result.changes === 0) return null;
    const task = await this.getSlackTask(rows[0].id);
    if (!task) throw new Error(`Claimed research task disappeared: ${rows[0].id}`);
    return task;
  }

  async recoverSlackResearchTasks(): Promise<void> {
    await this.run(
      `UPDATE tasks SET slack_ack_state = 'failed', updated_at = ? WHERE slack_ack_state = 'posting'`,
      [this.clock.nowIso()],
    );
    await this.run(
      `UPDATE tasks SET slack_state = 'queued',
       run_status = CASE WHEN run_status = 'running' THEN 'crashed' ELSE run_status END,
       stop_reason = CASE WHEN run_status = 'running' THEN 'crash' ELSE stop_reason END,
       ended_at = CASE WHEN run_status = 'running' THEN ? ELSE ended_at END,
       updated_at = ? WHERE task_type = 'research' AND slack_state = 'running'`,
      [this.clock.nowIso(), this.clock.nowIso()],
    );
    await this.run(
      `UPDATE tasks SET slack_state = 'failed', error = 'Slack reply outcome unknown after restart', updated_at = ?
       WHERE task_type IN ('coding', 'research') AND slack_state = 'posting'`,
      [this.clock.nowIso()],
    );
  }

  async completeSlackResearchTask(id: string, answer: string, summary?: string): Promise<SlackTaskRecord | null> {
    if (!answer.trim()) throw new Error("Research answer must not be empty");
    if (summary !== undefined && (!summary.trim() || summary.length > 600)) throw new Error("Research summary must be 1–600 characters");
    const now = this.clock.nowIso();
    const result = await this.run(
      `UPDATE tasks SET result_json = ?, slack_state = 'awaiting_coordination', updated_at = ?, completed_at = ?
       WHERE id = ? AND task_type = 'research' AND slack_state = 'running'`,
      [JSON.stringify(summary === undefined ? { answer } : { answer, summary }), now, now, id],
    );
    if (result.changes !== 1) {
      const current = await this.getSlackTask(id);
      if (current?.state === "canceled" || current?.state === "coordinated") return null;
      throw new Error(`Research task is not running: ${id}`);
    }
    const task = await this.getSlackTask(id);
    if (!task) throw new Error(`Completed research task disappeared: ${id}`);
    return task;
  }

  async approveSlackResearchResult(id: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_state = 'approved', updated_at = ?
       WHERE id = ? AND task_type = 'research' AND slack_state = 'awaiting_coordination' AND result_json IS NOT NULL`,
      [this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot approve research result: ${id}`);
  }

  async failSlackTask(id: string, error: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_state = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND task_type IN ('coding', 'research') AND slack_state != 'coordinated'`,
      [error, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot fail Slack task: ${id}`);
  }

  async resumeSlackTicketReplacement(id: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_state = CASE WHEN ticket_id IS NULL THEN 'queued' ELSE 'awaiting_coordination' END,
       error = NULL, updated_at = ? WHERE id = ? AND task_type = 'coding' AND slack_state = 'failed'
       AND slack_ack_state IS NULL`,
      [this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot resume Slack ticket replacement: ${id}`);
  }

  async attachSlackTicket(id: string, ticketId: string, ticketUrl: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET ticket_id = ?, ticket_url = ?, slack_state = 'awaiting_coordination', updated_at = ?
       WHERE id = ? AND task_type = 'coding' AND slack_state = 'queued'`,
      [ticketId, ticketUrl, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot attach ticket to Slack task: ${id}`);
  }

  async hasSlackLinkedTicket(ticketIssueId: string): Promise<boolean> {
    const rows = await this.query<{ one: number }>(
      `SELECT 1 AS one FROM tasks WHERE ticket_id = ? AND slack_workspace_id IS NOT NULL LIMIT 1`,
      [ticketIssueId],
    );
    return rows.length > 0;
  }

  async cancelSlackTask(id: string, supersededBy?: string): Promise<void> {
    if (id === supersededBy) throw new Error("Cannot replace a task with itself");
    const result = await this.run(
      `UPDATE tasks SET slack_state = 'canceled', slack_ack_state = NULL, superseded_by = ?, coordinated_at = NULL, updated_at = ?
       WHERE id = ? AND task_type IN ('coding', 'research') AND slack_state NOT IN ('failed', 'canceled')`,
      [supersededBy ?? null, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot cancel Slack task: ${id}`);
  }

  async beginSlackTaskReply(id: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_state = 'posting', updated_at = ? WHERE id = ? AND slack_state IN ('awaiting_coordination', 'approved')`,
      [this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot begin Slack task reply: ${id}`);
  }

  async beginSlackBatchAcknowledgment(ids: string[]): Promise<void> {
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Acknowledgment batch requires distinct task IDs");
    const result = await this.run(
      `UPDATE tasks SET slack_ack_state = 'posting',
       slack_state = CASE WHEN task_type = 'coding' AND slack_state = 'awaiting_coordination' THEN 'posting' ELSE slack_state END,
       updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND slack_ack_state IS NULL`,
      [this.clock.nowIso(), ...ids],
    );
    if (result.changes !== ids.length) throw new Error("Cannot begin Slack batch acknowledgment");
  }

  async failSlackBatchAcknowledgment(ids: string[], error: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_ack_state = NULL,
       slack_state = CASE WHEN task_type = 'coding' AND slack_state = 'posting' THEN 'awaiting_coordination' ELSE slack_state END,
       error = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND slack_ack_state = 'posting'`,
      [error, this.clock.nowIso(), ...ids],
    );
    if (result.changes !== ids.length) throw new Error("Cannot fail Slack batch acknowledgment");
  }

  async markSlackResearchStartedReply(id: string, replyTs: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_reply_ts = ?, slack_ack_state = 'posted', updated_at = ? WHERE id = ? AND task_type = 'research'
       AND slack_state IN ('queued', 'running', 'awaiting_coordination', 'approved') AND slack_ack_state = 'posting'`,
      [replyTs, this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot record research start reply: ${id}`);
  }

  async markSlackTaskCoordinated(id: string, replyTs?: string): Promise<void> {
    const result = await this.run(
      `UPDATE tasks SET slack_state = CASE WHEN slack_state = 'canceled' THEN 'canceled' ELSE 'coordinated' END,
       slack_ack_state = CASE WHEN slack_ack_state = 'posting' THEN 'posted' ELSE slack_ack_state END,
       slack_reply_ts = ?, coordinated_at = ?, updated_at = ?
       WHERE id = ? AND task_type IN ('coding', 'research') AND slack_state IN ('posting', 'canceled')`,
      [replyTs ?? null, this.clock.nowIso(), this.clock.nowIso(), id],
    );
    if (result.changes !== 1) throw new Error(`Cannot coordinate Slack task: ${id}`);
  }

  async upsertTicketDiscovered(ticket: TicketInput): Promise<void> {
    const now = this.clock.nowIso();
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
    // Preserve notify across non-validating transitions: a re-dispatch to in_progress must not clear a pending notify=1.
    const fn = this.scalarMax();
    await this.run(
      `INSERT INTO ticket_statuses (ticket_id, status, notify, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (ticket_id) DO UPDATE SET status = excluded.status,
         notify = CASE WHEN excluded.status = 'validating' THEN ${fn}(ticket_statuses.notify, excluded.notify) ELSE ticket_statuses.notify END,
         updated_at = excluded.updated_at`,
      [ticketId, status, notifyInt, now],
    );
    if (status === "completed") {
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

  async tryTransitionToWaitingForHuman(ticketId: string, completedTaskId: string): Promise<boolean> {
    const now = this.clock.nowIso();
    const latestCompletedGuard = `
      (SELECT id FROM tasks WHERE ticket_id = ? AND dispatch_state IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1) = ?
      AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND result_status IS NOT NULL)`;
    const guardParams = [ticketId, completedTaskId, completedTaskId];
    await this.run(
      `UPDATE ticket_statuses SET status = 'waiting_for_human', updated_at = ?
       WHERE ticket_id = ? AND status = 'validating' AND ${latestCompletedGuard}`,
      [now, ticketId, ...guardParams],
    );
    const pending = await this.query<{ notify: number }>(
      `SELECT notify FROM ticket_statuses
       WHERE ticket_id = ? AND status = 'waiting_for_human' AND notify = 1 AND ${latestCompletedGuard}`,
      [ticketId, ...guardParams],
    );
    return pending.length === 1;
  }

  async clearPendingNotification(ticketId: string, completedTaskId: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE ticket_statuses SET notify = 0, updated_at = ?
       WHERE ticket_id = ? AND notify = 1
         AND NOT EXISTS (
           SELECT 1 FROM tasks newer
           WHERE newer.ticket_id = ? AND newer.dispatch_state IS NOT NULL AND newer.id <> ?
             AND newer.result_status IS NOT NULL
             AND newer.created_at > (SELECT created_at FROM tasks WHERE id = ?)
         )`,
      [now, ticketId, ticketId, completedTaskId, completedTaskId],
    );
  }

  async claimPrNotifications(
    taskId: string,
    prIds: string[],
    leaseMs: number,
  ): Promise<{ claimToken: string; claimed: string[] }> {
    const claimToken = randomUUID();
    const claimed: string[] = [];
    for (const prId of prIds) {
      const now = this.clock.nowIso();
      const inserted = await this.run(
        `INSERT INTO pr_notification_deliveries (task_id, pr_id, state, claim_token, claimed_at)
         VALUES (?, ?, 'sending', ?, ?) ON CONFLICT (task_id, pr_id) DO NOTHING`,
        [taskId, prId, claimToken, now],
      );
      if (inserted.changes === 1) {
        claimed.push(prId);
        continue;
      }
      const leaseExpiredBefore = new Date(Date.parse(now) - leaseMs).toISOString();
      const taken = await this.run(
        `UPDATE pr_notification_deliveries SET claim_token = ?, claimed_at = ?
         WHERE task_id = ? AND pr_id = ? AND state = 'sending' AND claimed_at < ?`,
        [claimToken, now, taskId, prId, leaseExpiredBefore],
      );
      if (taken.changes === 1) claimed.push(prId);
    }
    return { claimToken, claimed };
  }

  async markPrNotificationDelivered(taskId: string, prId: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE pr_notification_deliveries SET state = 'delivered', delivered_at = ? WHERE task_id = ? AND pr_id = ?`,
      [now, taskId, prId],
    );
  }

  async releasePrNotificationClaim(taskId: string, prId: string, claimToken: string): Promise<void> {
    await this.run(
      `DELETE FROM pr_notification_deliveries
       WHERE task_id = ? AND pr_id = ? AND state = 'sending' AND claim_token = ?`,
      [taskId, prId, claimToken],
    );
  }

  async listDeliveredPrNotifications(taskId: string): Promise<Set<string>> {
    const rows = await this.query<{ pr_id: string }>(
      `SELECT pr_id FROM pr_notification_deliveries WHERE task_id = ? AND state = 'delivered'`,
      [taskId],
    );
    return new Set(rows.map((r) => r.pr_id));
  }

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

  async upsertRunCrashed(taskId: string, error: string, lease: { workerId: string | null; reclaimCount: number; abandoned?: boolean }): Promise<boolean> {
    const now = this.clock.nowIso();
    const result = await this.run(
      `UPDATE tasks SET run_status = 'crashed', stop_reason = 'crash',
         error = ?, ended_at = ?, updated_at = ?
       WHERE id = ? AND reclaim_count = ? AND ${lease.workerId === null ? "worker_id IS NULL" : "worker_id = ?"}
         AND ${lease.abandoned ? "result_status = 'pending' AND slot_status = 'released'" : "result_status IS NULL"}`,
      [error, now, now, taskId, lease.reclaimCount, ...(lease.workerId === null ? [] : [lease.workerId])],
    );
    return result.changes === 1;
  }

  async upsertToolCalls(taskId: string, toolCallsJson: string): Promise<void> {
    const now = this.clock.nowIso();
    await this.run(
      `UPDATE tasks SET tool_calls_json = ?, updated_at = ? WHERE id = ?`,
      [toolCallsJson, now, taskId],
    );
  }

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

  async recordEvent(event: EventInput): Promise<void> {
    await this.run(
      `INSERT INTO events (id, ticket_id, run_id, worker_id, source, type, summary, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.ticketId, event.runId, event.workerId, event.source,
       event.type, event.summary, event.payloadJson, event.createdAt],
    );
  }

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const now = this.clock.nowIso();
    // ticket_id stores the Linear UUID, not the human-readable identifier (e.g. "ABC-123").
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

  async complete(taskId: string, result: DispatchResult, workerId?: string, reclaimCount?: number): Promise<void> {
    const now = this.clock.nowIso();
    const update = await this.run(
      `UPDATE tasks SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL${workerId === undefined ? "" : " AND worker_id = ?"}${reclaimCount === undefined ? "" : " AND reclaim_count = ?"}`,
      [result.status, JSON.stringify(result), now, now, taskId, ...(workerId === undefined ? [] : [workerId]), ...(reclaimCount === undefined ? [] : [reclaimCount])],
    );
    if (update.changes !== 1) {
      throw new Error(`Cannot complete task that is missing, unacquired, or already completed: ${taskId}`);
    }
  }

  async listTracked(): Promise<TaskSlot[]> {
    if (this.dialect === "sqlite") {
      const rows = await this.query<TaskRow>(`
        SELECT * FROM (
          SELECT tasks.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS row_number
          FROM tasks WHERE ticket_id IS NOT NULL AND dispatch_state IS NOT NULL
        )
        WHERE row_number = 1 AND slot_status != 'released'
        ORDER BY created_at ASC, id ASC
      `);
      return rows.map(rowToSlot);
    }
    const rows = await this.query<TaskRow>(`
      SELECT * FROM (
        SELECT DISTINCT ON (ticket_id) * FROM tasks WHERE ticket_id IS NOT NULL AND dispatch_state IS NOT NULL ORDER BY ticket_id, created_at DESC, id DESC
      ) latest
      WHERE slot_status != 'released'
      ORDER BY created_at ASC, id ASC
    `);
    return rows.map(rowToSlot);
  }

  async getTrackedSlot(ticketId: string): Promise<TaskSlot | null> {
    const rows = await this.query<TaskRow>(
      `SELECT * FROM tasks WHERE ticket_id = ? AND dispatch_state IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ticketId],
    );
    const row = rows[0];
    if (!row || row.slot_status === "released") return null;
    return rowToSlot(row);
  }

  async listStaleWaitingForHuman(): Promise<StaleWaitingForHumanRow[]> {
    if (this.dialect === "sqlite") {
      const rows = await this.query<TaskRow>(`
        SELECT ranked.* FROM (
          SELECT tasks.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS rn
          FROM tasks
          WHERE ticket_id IS NOT NULL
        ) ranked
        JOIN ticket_statuses ts ON ts.ticket_id = ranked.ticket_id
        WHERE ranked.rn = 1 AND ts.status = 'waiting_for_human' AND ranked.slot_status = 'released'
        ORDER BY ranked.created_at ASC, ranked.id ASC
      `);
      return rows.map(rowToStaleWaitingForHumanRow);
    }
    const rows = await this.query<TaskRow>(`
      SELECT latest.* FROM (
        SELECT DISTINCT ON (ticket_id) * FROM tasks
        WHERE ticket_id IS NOT NULL
        ORDER BY ticket_id, created_at DESC, id DESC
      ) latest
      JOIN ticket_statuses ts ON ts.ticket_id = latest.ticket_id
      WHERE ts.status = 'waiting_for_human' AND latest.slot_status = 'released'
      ORDER BY latest.created_at ASC, latest.id ASC
    `);
    return rows.map(rowToStaleWaitingForHumanRow);
  }

  async listWaitingForHumanTicketIds(): Promise<string[]> {
    const rows = await this.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM ticket_statuses WHERE status = 'waiting_for_human'`,
    );
    return rows.map((r) => r.ticket_id);
  }

  async countTracked(): Promise<number> {
    if (this.dialect === "sqlite") {
      const rows = await this.query<{ cnt: number }>(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT ticket_id FROM (
            SELECT ticket_id, slot_status,
                   ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS rn
            FROM tasks WHERE ticket_id IS NOT NULL AND dispatch_state IS NOT NULL
          ) WHERE rn = 1 AND slot_status != 'released'
        )
      `);
      return Number(rows[0]?.cnt ?? 0);
    }
    const rows = await this.query<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT DISTINCT ON (ticket_id) slot_status
        FROM tasks WHERE ticket_id IS NOT NULL AND dispatch_state IS NOT NULL
        ORDER BY ticket_id, created_at DESC, id DESC
      ) latest WHERE slot_status != 'released'
    `);
    return Number(rows[0]?.cnt ?? 0);
  }

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

  async getIterationCount(ticketId: string): Promise<number> {
    const rows = await this.query<{ count: number | string }>(
      `SELECT COUNT(*) as count FROM tasks WHERE ticket_id = ?`,
      [ticketId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async heartbeat(taskId: string, workerId: string, reclaimCount?: number): Promise<boolean> {
    const now = this.clock.nowIso();
    const result = await this.run(
      `UPDATE tasks SET worker_heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND worker_id = ? AND result_status IS NULL${reclaimCount === undefined ? "" : " AND reclaim_count = ?"}`,
      [now, now, taskId, workerId, ...(reclaimCount === undefined ? [] : [reclaimCount])],
    );
    return result.changes === 1;
  }

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

  async markCrashed(taskId: string, workerId: string, maxReclaims: number, reclaimCount?: number): Promise<ReclaimResult | null> {
    if (this.dialect === "sqlite") {
      const db = this.requireSqlite();
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (!row || row.worker_id !== workerId || row.result_status !== null || (reclaimCount !== undefined && Number(row.reclaim_count) !== reclaimCount)) return null;
      return this.sqliteApplyRecovery(db, row, maxReclaims, `worker ${workerId} reported crash`);
    }

    const pool = this.requirePg();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
      const row = result.rows[0];
      if (!row || row.worker_id !== workerId || row.result_status !== null || (reclaimCount !== undefined && Number(row.reclaim_count) !== reclaimCount)) {
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

  async close(): Promise<void> {
    this.sqlite?.close();
    this.sqlite = null;
    await this.pgPool?.end();
    this.pgPool = null;
  }

  async listTickets(options: ListTicketsOptions): Promise<ListTicketsResult> {
    const page = clampPage(options.page);
    const pageSize = clampPageSize(options.pageSize);
    const offset = (page - 1) * pageSize;

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

    if (options.workerIds && options.workerIds.length > 0) {
      const placeholders = options.workerIds.map(() => "?").join(", ");
      conditions.push(`worker_id IN (${placeholders})`);
      params.push(...options.workerIds);
    }

    if (options.stopReasons && options.stopReasons.length > 0) {
      const placeholders = options.stopReasons.map(() => "?").join(", ");
      conditions.push(`stop_reason IN (${placeholders})`);
      params.push(...options.stopReasons);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const filteredTicketsCte = `
      WITH latest AS (
        SELECT * FROM (
          SELECT tasks.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS rn
          FROM tasks
          WHERE ticket_id IS NOT NULL
        ) ranked
        WHERE rn = 1
      ),
      filtered AS (
        SELECT latest.*, ts.status AS ts_status
        FROM latest
        LEFT JOIN ticket_statuses ts ON ts.ticket_id = latest.ticket_id
        ${whereClause}
      )
    `;

    const countRows = await this.query<{ total_count: number | string }>(
      this.sql(`${filteredTicketsCte} SELECT COUNT(*) AS total_count FROM filtered`),
      params,
    );
    const total = Number(countRows[0]?.total_count ?? 0);

    const pageRows = await this.query<TaskRow>(
      this.sql(`
        ${filteredTicketsCte}
        SELECT filtered.*
        FROM filtered
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `),
      [...params, pageSize, offset],
    );
    if (pageRows.length === 0) {
      return { items: [], total, page, pageSize };
    }

    const ticketIds = pageRows.map((r) => r.ticket_id).filter((id): id is string => id !== null);
    const prPlaceholders = ticketIds.map(() => "?").join(", ");

    const prRows = ticketIds.length > 0
      ? await this.query<{
          id: string;
          ticket_id: string;
          number: number;
          title: string;
          head_ref: string;
          url: string;
          state: string;
          draft: number | boolean;
          merged: number | boolean;
          updated_at: string;
        }>(
          this.sql(
            `SELECT id, ticket_id, number, title, head_ref, url, state, draft, merged, updated_at
             FROM pull_requests
             WHERE ticket_id IN (${prPlaceholders})
             ORDER BY updated_at DESC`,
          ),
          ticketIds,
        )
      : [];

    const prsByTicket = new Map<string, TicketListPullRequest[]>();
    for (const pr of prRows) {
      const ticketPrs = prsByTicket.get(pr.ticket_id) ?? [];
      ticketPrs.push({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        headRef: pr.head_ref,
        url: pr.url,
        state: pr.state,
        draft: intBool(pr.draft),
        merged: intBool(pr.merged),
      });
      prsByTicket.set(pr.ticket_id, ticketPrs);
    }

    const workerIds = Array.from(new Set(pageRows.map((r) => r.worker_id).filter((id): id is string => id !== null)));
    let workerNameById = new Map<string, string>();
    if (workerIds.length > 0) {
      for (const wid of workerIds) workerNameById.set(wid, wid);
    }

    const enriched: TicketListItem[] = pageRows.map((row) => {
      const item = rowToTicketListItem(row);
      item.latestRun = row.run_status !== null ? toLatestRunSummary(row) : null;
      item.latestWorkerName = row.worker_id ? workerNameById.get(row.worker_id) ?? row.worker_id : null;
      item.pullRequests = row.ticket_id ? prsByTicket.get(row.ticket_id) ?? [] : [];
      return item;
    });

    return { items: enriched, total, page, pageSize };
  }

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

    const workerRows = await this.query<{ worker_id: string }>(
      `SELECT DISTINCT worker_id FROM tasks WHERE worker_id IS NOT NULL AND run_status IS NOT NULL ORDER BY worker_id`,
    );
    const workers = workerRows.map((w) => ({ id: w.worker_id, name: w.worker_id }));

    const allBmStatuses: BmStatus[] = ["in_progress", "validating", "waiting_for_human", "failed", "completed"];

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

  async getTicketDetail(id: string): Promise<TicketDetail | null> {
    const taskRows = await this.query<TaskRow>(
      `SELECT t.*, ts.status AS ts_status
         FROM tasks t
         LEFT JOIN ticket_statuses ts ON ts.ticket_id = t.ticket_id
        WHERE t.ticket_id = ?
        ORDER BY t.created_at ASC`,
      [id],
    );
    if (taskRows.length === 0) return null;

    const latestTaskRow = taskRows[taskRows.length - 1]!;
    const ticket = rowToTicketListItem(latestTaskRow);

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
                  resultStatus: t.resultStatus != null ? String(t.resultStatus) : null,
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
      createdAt: parseTimestampRequired(e.created_at, "created_at"),
    }));

    return { ticket, runs, pullRequests, events };
  }

  async getToolCallDetail(runId: string, sequence: number): Promise<ToolCallDetail | null> {
    const rows = await this.query<{ tool_calls_json: string | null }>(
      `SELECT tool_calls_json FROM tasks WHERE id = ?`,
      [runId],
    );
    if (rows.length === 0 || !rows[0]!.tool_calls_json) return null;
    const parsed: unknown = JSON.parse(rows[0]!.tool_calls_json);
    if (!Array.isArray(parsed)) {
      throw new Error(`tool_calls_json for task ${runId} is not an array`);
    }
    const entry = parsed.find((tc, idx) => {
      const t = tc as Record<string, unknown>;
      const seq = t.sequence != null ? Number(t.sequence) : idx;
      return seq === sequence;
    }) as Record<string, unknown> | undefined;
    if (!entry) return null;
    return {
      argsJson: String(entry.argsJson ?? entry.args_json ?? "{}"),
      resultText: entry.resultText != null ? String(entry.resultText) : null,
      outputSize: entry.outputSize != null ? Number(entry.outputSize) : null,
      thoughtText: entry.thoughtText != null ? String(entry.thoughtText) : null,
    };
  }

  async getEventPayload(eventId: string): Promise<string | null> {
    const rows = await this.query<{ payload_json: string | null }>(
      `SELECT payload_json FROM events WHERE id = ?`,
      [eventId],
    );
    if (rows.length === 0) return null;
    return rows[0]!.payload_json;
  }

  async listWorkers(): Promise<WorkerListItem[]> {
    const now = new Date();
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

  async getPeriodSummary({ from, to }: PeriodSummaryOptions): Promise<PeriodSummary> {
    const durationMs = to.getTime() - from.getTime();
    const priorFrom = new Date(from.getTime() - durationMs);
    const priorTo = from;
    const outerFrom = priorFrom;
    const outerTo = to;

    const [allTasks, allPrs] = await Promise.all([
      this.query<PeriodTaskRow>(
        `SELECT t.id, t.ticket_id, t.ticket_identifier, t.ticket_title, t.ticket_url, t.ticket_labels_json,
           ts.status AS bm_status, t.attempt_count, t.ticket_completed_at,
           t.run_status, t.started_at, t.ended_at, t.prompt_tokens, t.completion_tokens,
           t.model_name, t.provider, t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN ticket_statuses ts ON ts.ticket_id = t.ticket_id
         WHERE t.ticket_id IS NOT NULL AND t.created_at >= ? AND t.created_at < ?`,
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
