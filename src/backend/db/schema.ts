import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  branchName: text("branch_name").notNull(),
  linearStatusName: text("linear_status_name").notNull(),
  linearStatusType: text("linear_status_type").notNull(),
  labelsJson: text("labels_json").notNull().default("[]"),
  bmStatus: text("bm_status", {
    enum: ["discovered", "dispatched", "in_progress", "pr_open", "ci_running", "ci_failed", "completed", "abandoned"],
  }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  completedAt: ts("completed_at"),
});

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["idle", "busy", "stopped", "dead"] }).notNull(),
  currentRunId: text("current_run_id"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  startedAt: ts("started_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  attemptNumber: integer("attempt_number").notNull(),
  workerId: text("worker_id").references(() => workers.id),
  trigger: text("trigger", { enum: ["new", "ci_failure", "delegated_back", "merge_conflict"] }).notNull(),
  status: text("status", {
    enum: ["dispatched", "running", "succeeded", "failed", "timed_out", "crashed"],
  }).notNull(),
  contextJson: text("context_json"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  stopReason: text("stop_reason", { enum: ["completed", "timeout", "crash", "error"] }),
  error: text("error"),
  // LLM usage stats captured from the pi agent session when the run completes.
  // Nullable: older runs and runs that crashed before any model call won't have them.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  modelName: text("model_name"),
  provider: text("provider"),
  createdAt: ts("created_at").notNull(),
});

export const pullRequests = sqliteTable("pull_requests", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  headRef: text("head_ref").notNull(),
  state: text("state", { enum: ["open", "closed"] }).notNull(),
  draft: integer("draft", { mode: "boolean" }).notNull(),
  merged: integer("merged", { mode: "boolean" }).notNull(),
  url: text("url").notNull(),
  lastRunId: text("last_run_id").references(() => runs.id),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const ciRuns = sqliteTable("ci_runs", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  runId: text("run_id").notNull().references(() => runs.id),
  prId: text("pr_id").references(() => pullRequests.id),
  status: text("status", { enum: ["running", "passed", "failed"] }).notNull(),
  url: text("url"),
  summary: text("summary"),
  createdAt: ts("created_at").notNull(),
  completedAt: ts("completed_at"),
});

/**
 * One row per failing CI check (a GitHub check_run that completed with a non-success conclusion,
 * or a commit status that is not "success"). Lets the dashboard surface specific lint/type/test
 * failures rather than a single CI "failed" boolean.
 */
export const ciChecks = sqliteTable("ci_checks", {
  id: text("id").primaryKey(),
  ciRunId: text("ci_run_id").notNull().references(() => ciRuns.id),
  /** Source side of the check: GitHub check_run ("check_run") vs commit status ("status"). */
  source: text("source", { enum: ["check_run", "status"] }).notNull(),
  /** GitHub-side id (check_run.id or status context) — used to make rows idempotent across polls. */
  externalId: text("external_id").notNull(),
  name: text("name").notNull(),
  conclusion: text("conclusion"),
  detailsUrl: text("details_url"),
  summary: text("summary"),
  /** GitHub check_run.output.text annotations — line-level test/lint failures. */
  annotationsJson: text("annotations_json").notNull().default("[]"),
  createdAt: ts("created_at").notNull(),
});

/**
 * One row per PR review thread (resolved or unresolved). The full comment chain is stored as JSON
 * so the dashboard can render replies and resolution status without a second table.
 */
export const reviewThreads = sqliteTable("review_threads", {
  /** GitHub GraphQL node id of the thread — stable across polls. */
  id: text("id").primaryKey(),
  prId: text("pr_id").notNull().references(() => pullRequests.id),
  path: text("path"),
  line: integer("line"),
  isResolved: integer("is_resolved", { mode: "boolean" }).notNull(),
  /** Serialized ReviewThreadComment[] — author/body/url/timestamps for every comment in the thread. */
  commentsJson: text("comments_json").notNull().default("[]"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

/**
 * Step-by-step trace of an agent run's tool calls and interleaved assistant reasoning, used
 * by the dashboard's "thought process" visualizer (DEN-2311). The set is replaced on every
 * upsert: the worker re-sends the full ordered list at run completion, so dialect-specific
 * upsert semantics don't matter.
 */
export const runToolCalls = sqliteTable("run_tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  /** 0-based position within the run; used to preserve chronological ordering. */
  sequence: integer("sequence").notNull(),
  toolName: text("tool_name").notNull(),
  /** Serialized tool input parameters (best-effort JSON.stringify of the raw args object). */
  argsJson: text("args_json").notNull(),
  /** Serialized tool result content (truncated to MAX_TOOL_CALL_RESULT_CHARS by the worker). */
  resultText: text("result_text"),
  resultStatus: text("result_status", { enum: ["ok", "error", "unknown"] }),
  /** Character length of the untruncated result — lets the UI flag truncated payloads. */
  outputSize: integer("output_size"),
  /** Assistant text emitted in the same turn as the tool_use block — the "thought" preceding the call. */
  thoughtText: text("thought_text"),
  createdAt: ts("created_at").notNull(),
});

/**
 * Append-only log of worker `status` transitions, used to render the worker-utilization
 * Gantt chart (DEN-2335). Each row is one contiguous span in a single status: a new row is
 * opened on every transition (and on first-seen) with `endedAt = null`; the previously open
 * row for the worker is closed by setting its `endedAt` to the transition time. This keeps the
 * timeline reconstructable from a single range scan on (workerId, startedAt) without replaying
 * the full `events` log.
 */
export const workerStateTransitions = sqliteTable("worker_state_transitions", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull().references(() => workers.id),
  status: text("status", { enum: ["idle", "busy", "stopped", "dead"] }).notNull(),
  startedAt: ts("started_at").notNull(),
  endedAt: ts("ended_at"),
  createdAt: ts("created_at").notNull(),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").references(() => tickets.id),
  runId: text("run_id").references(() => runs.id),
  workerId: text("worker_id").references(() => workers.id),
  source: text("source", { enum: ["manager", "worker", "ci"] }).notNull(),
  type: text("type", {
    enum: ["ticket_discovered", "dispatched", "branch_created", "progress", "pr_opened", "ci_started", "ci_passed", "ci_failed", "delegated_back", "worker_timeout", "worker_crashed", "ticket_completed", "ticket_abandoned"],
  }).notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json"),
  createdAt: ts("created_at").notNull(),
});
