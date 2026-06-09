import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload, EventPayload,
} from "../../shared/dashboard/types.js";

type Db = BetterSQLite3Database<typeof schema>;
const d = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

export function upsertTicket(db: Db, p: TicketPayload): void {
  const row = {
    id: p.id, identifier: p.identifier, title: p.title, description: p.description,
    url: p.url, branchName: p.branchName, linearStatusName: p.linearStatusName,
    linearStatusType: p.linearStatusType, labelsJson: JSON.stringify(p.labels),
    bmStatus: p.bmStatus, attemptCount: p.attemptCount, maxAttempts: p.maxAttempts,
    createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt), completedAt: d(p.completedAt),
  };
  db.insert(schema.tickets).values(row).onConflictDoUpdate({ target: schema.tickets.id, set: row }).run();
}

export function upsertWorker(db: Db, p: WorkerPayload): void {
  const row = {
    id: p.id, name: p.name, status: p.status, currentRunId: p.currentRunId,
    lastHeartbeatAt: d(p.lastHeartbeatAt), startedAt: new Date(p.startedAt), updatedAt: new Date(p.updatedAt),
  };
  // Record a status transition iff this is a new worker OR the status changed.
  // The transitions table is append-only and powers the worker utilization Gantt chart.
  // Must capture prev BEFORE the upsert so we can compare; insert the transition AFTER the
  // worker row exists to satisfy the FK on first-seen workers.
  const prev = db.select({ status: schema.workers.status }).from(schema.workers).where(eq(schema.workers.id, p.id)).get();
  db.insert(schema.workers).values(row).onConflictDoUpdate({ target: schema.workers.id, set: row }).run();
  if (!prev || prev.status !== p.status) {
    db.insert(schema.workerStatusTransitions).values({
      id: globalThis.crypto.randomUUID(),
      workerId: p.id,
      status: p.status,
      changedAt: new Date(p.updatedAt),
    }).run();
  }
}

export function upsertRun(db: Db, p: RunPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, attemptNumber: p.attemptNumber, workerId: p.workerId,
    trigger: p.trigger, status: p.status, contextJson: p.contextJson,
    startedAt: d(p.startedAt), endedAt: d(p.endedAt), stopReason: p.stopReason, error: p.error,
    createdAt: new Date(p.createdAt),
  };
  db.insert(schema.runs).values(row).onConflictDoUpdate({
    target: schema.runs.id,
    set: {
      ...row,
      // createdAt is immutable after insert; startedAt is set-once (never reset to null by a later transition).
      createdAt: sql`${schema.runs.createdAt}`,
      startedAt: sql`coalesce(${schema.runs.startedAt}, excluded.started_at)`,
    },
  }).run();
}

export function upsertPullRequest(db: Db, p: PullRequestPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, number: p.number, title: p.title, headRef: p.headRef,
    state: p.state, draft: p.draft, merged: p.merged, url: p.url, lastRunId: p.lastRunId,
    createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
  };
  db.insert(schema.pullRequests).values(row).onConflictDoUpdate({ target: schema.pullRequests.id, set: row }).run();
}

export function upsertCiRun(db: Db, p: CiRunPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, runId: p.runId, prId: p.prId, status: p.status,
    url: p.url, summary: p.summary, createdAt: new Date(p.createdAt), completedAt: d(p.completedAt),
  };
  db.insert(schema.ciRuns).values(row).onConflictDoUpdate({ target: schema.ciRuns.id, set: row }).run();
}

export function insertEvent(db: Db, p: EventPayload): void {
  db.insert(schema.events).values({
    id: globalThis.crypto.randomUUID(),
    ticketId: p.ticketId, runId: p.runId, workerId: p.workerId, source: p.source,
    type: p.type, summary: p.summary, payloadJson: p.payloadJson, createdAt: new Date(p.createdAt),
  }).run();
}
