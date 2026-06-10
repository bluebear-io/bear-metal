import { pgTable, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";

/**
 * Postgres mirror of the SQLite schema in `./schema.ts`. Column names, nullability, defaults, and
 * `text({ enum: [...] })` choices match exactly so the Drizzle `$inferSelect`/`$inferInsert` shapes
 * resolve to the same TypeScript types regardless of dialect. The rest of the backend keeps
 * referencing a single `Ticket`/`NewTicket`/etc. type.
 *
 * Notes on dialect-specific choices:
 *   - Timestamp columns use `timestamp({ withTimezone: true, mode: "date" })` to map JS `Date`,
 *     matching SQLite's `integer({ mode: "timestamp_ms" })` which also exposes Date.
 *   - Enums are kept as `text({ enum: [...] })` instead of `pgEnum` so we don't need migration
 *     ceremony when an enum value is added and so the inferred TS types stay literal-narrow on
 *     both dialects without diverging.
 *   - Booleans use the native PG `boolean`, matching SQLite's `integer({ mode: "boolean" })`.
 *
 * FK declarations mirror `schema.ts` purely as relationship documentation; the dashboard writes
 * out-of-order best-effort rows (a child can arrive before its parent), so FK enforcement is
 * disabled at the session level by the writable DB opener.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const tickets = pgTable("tickets", {
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

export const workers = pgTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["idle", "busy", "stopped", "dead"] }).notNull(),
  currentRunId: text("current_run_id"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  startedAt: ts("started_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const runs = pgTable("runs", {
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

export const pullRequests = pgTable("pull_requests", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  headRef: text("head_ref").notNull(),
  state: text("state", { enum: ["open", "closed"] }).notNull(),
  draft: boolean("draft").notNull(),
  merged: boolean("merged").notNull(),
  url: text("url").notNull(),
  lastRunId: text("last_run_id").references(() => runs.id),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const ciRuns = pgTable("ci_runs", {
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

export const events = pgTable("events", {
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
