import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql, eq } from "drizzle-orm";
import * as schema from "./schema.js";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload,
  CiCheckPayload, ReviewThreadPayload, EventPayload,
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
  db.insert(schema.tickets).values(row).onConflictDoUpdate({
    target: schema.tickets.id,
    set: { ...row, createdAt: sql`${schema.tickets.createdAt}` },
  }).run();
}

export function upsertWorker(db: Db, p: WorkerPayload): void {
  const row = {
    id: p.id, name: p.name, status: p.status, currentRunId: p.currentRunId,
    lastHeartbeatAt: d(p.lastHeartbeatAt), startedAt: new Date(p.startedAt), updatedAt: new Date(p.updatedAt),
  };
  // Record a status transition iff this is a new worker OR the status changed.
  // The transitions table is append-only and powers the worker utilization Gantt chart.
  // Must capture prev BEFORE the upsert so we can compare; insert the transition AFTER the
  // worker row exists to satisfy the FK on first-seen workers. Wrap in a transaction so
  // concurrent upserts of the same worker cannot read stale prev and double-insert (or
  // skip) a transition row.
  db.transaction((tx) => {
    const prev = tx.select({ status: schema.workers.status }).from(schema.workers).where(eq(schema.workers.id, p.id)).get();
    tx.insert(schema.workers).values(row).onConflictDoUpdate({ target: schema.workers.id, set: row }).run();
    if (!prev || prev.status !== p.status) {
      tx.insert(schema.workerStatusTransitions).values({
        id: globalThis.crypto.randomUUID(),
        workerId: p.id,
        status: p.status,
        changedAt: new Date(p.updatedAt),
      }).run();
    }
  });
}

export function upsertRun(db: Db, p: RunPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, attemptNumber: p.attemptNumber, workerId: p.workerId,
    trigger: p.trigger, status: p.status, contextJson: p.contextJson,
    startedAt: d(p.startedAt), endedAt: d(p.endedAt), stopReason: p.stopReason, error: p.error,
    promptTokens: p.promptTokens, completionTokens: p.completionTokens,
    modelName: p.modelName, provider: p.provider,
    createdAt: new Date(p.createdAt),
  };
  db.insert(schema.runs).values(row).onConflictDoUpdate({
    target: schema.runs.id,
    set: {
      ...row,
      // createdAt is immutable after insert; startedAt and the usage fields are set-once —
      // a later transition (e.g. an out-of-order or duplicate status update) must never
      // wipe out previously-recorded values by sending null.
      createdAt: sql`${schema.runs.createdAt}`,
      startedAt: sql`coalesce(${schema.runs.startedAt}, excluded.started_at)`,
      promptTokens: sql`coalesce(excluded.prompt_tokens, ${schema.runs.promptTokens})`,
      completionTokens: sql`coalesce(excluded.completion_tokens, ${schema.runs.completionTokens})`,
      modelName: sql`coalesce(excluded.model_name, ${schema.runs.modelName})`,
      provider: sql`coalesce(excluded.provider, ${schema.runs.provider})`,
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

export function upsertCiCheck(db: Db, p: CiCheckPayload): void {
  const row = {
    id: p.id, ciRunId: p.ciRunId, source: p.source, externalId: p.externalId,
    name: p.name, conclusion: p.conclusion, detailsUrl: p.detailsUrl, summary: p.summary,
    annotationsJson: p.annotationsJson, createdAt: new Date(p.createdAt),
  };
  db.insert(schema.ciChecks).values(row).onConflictDoUpdate({ target: schema.ciChecks.id, set: row }).run();
}

/** Replace the set of failing checks attached to a CI run with `payloads` — keeps the row set in sync with the latest poll. */
export function replaceCiChecksForRun(db: Db, ciRunId: string, payloads: CiCheckPayload[]): void {
  db.transaction((tx) => {
    tx.delete(schema.ciChecks).where(sql`${schema.ciChecks.ciRunId} = ${ciRunId}`).run();
    for (const p of payloads) {
      upsertCiCheck(tx as unknown as Db, p);
    }
  });
}

export function upsertReviewThread(db: Db, p: ReviewThreadPayload): void {
  const row = {
    id: p.id, prId: p.prId, path: p.path, line: p.line, isResolved: p.isResolved,
    commentsJson: p.commentsJson, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
  };
  db.insert(schema.reviewThreads).values(row).onConflictDoUpdate({ target: schema.reviewThreads.id, set: row }).run();
}

/** Replace the set of review threads attached to a PR with `payloads` — mirrors GitHub's current thread set. */
export function replaceReviewThreadsForPr(db: Db, prId: string, payloads: ReviewThreadPayload[]): void {
  db.transaction((tx) => {
    tx.delete(schema.reviewThreads).where(sql`${schema.reviewThreads.prId} = ${prId}`).run();
    for (const p of payloads) {
      upsertReviewThread(tx as unknown as Db, p);
    }
  });
}

export function insertEvent(db: Db, p: EventPayload): void {
  db.insert(schema.events).values({
    id: globalThis.crypto.randomUUID(),
    ticketId: p.ticketId, runId: p.runId, workerId: p.workerId, source: p.source,
    type: p.type, summary: p.summary, payloadJson: p.payloadJson, createdAt: new Date(p.createdAt),
  }).run();
}
