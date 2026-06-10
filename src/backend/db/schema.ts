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
  trigger: text("trigger", { enum: ["new", "ci_failure", "delegated_back"] }).notNull(),
  status: text("status", {
    enum: ["dispatched", "running", "succeeded", "failed", "timed_out", "crashed"],
  }).notNull(),
  contextJson: text("context_json"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  stopReason: text("stop_reason", { enum: ["completed", "timeout", "crash", "error"] }),
  error: text("error"),
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

export const runLogs = sqliteTable("run_logs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  message: text("message").notNull(),
  level: text("level", { enum: ["debug", "info", "warn", "error"] }).notNull(),
  timestamp: ts("timestamp").notNull(),
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
