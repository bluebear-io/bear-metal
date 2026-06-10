import { sql } from "drizzle-orm";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload, EventPayload,
} from "../../shared/dashboard/types.js";
import type { DbHandle } from "./client.js";

/**
 * Dialect-agnostic dashboard writer. The ingest router and any other server-side caller go through
 * this interface rather than holding a Drizzle DB directly, so swapping the underlying dialect
 * (sqlite vs postgres, via the URL factory in client.ts) doesn't change call sites.
 *
 * Implementations live below: `createWriter(handle)` returns the dialect-specific impl.
 */
export interface Writer {
  upsertTicket(p: TicketPayload): Promise<void>;
  upsertWorker(p: WorkerPayload): Promise<void>;
  upsertRun(p: RunPayload): Promise<void>;
  upsertPullRequest(p: PullRequestPayload): Promise<void>;
  upsertCiRun(p: CiRunPayload): Promise<void>;
  insertEvent(p: EventPayload): Promise<void>;
}

const d = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/**
 * Both the SQLite and Postgres Drizzle query builders accept the same row shapes and chain the
 * same methods (`values`, `onConflictDoUpdate`), and both insert builders extend `QueryPromise`
 * so `await` triggers execution either way. The only thing TypeScript can't unify across the two
 * is the `insert(table)` table-argument variance — so the function is implemented once with
 * `any` typing internally, with the public Writer surface giving full type safety to callers.
 *
 * The parity test in `schema-pg.test.ts` guarantees the two dialects' inferred row shapes are
 * structurally identical, so the row literals built below are valid for both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWriter(db: any, tables: any): Writer {
  return {
    async upsertTicket(p) {
      const row = {
        id: p.id, identifier: p.identifier, title: p.title, description: p.description,
        url: p.url, branchName: p.branchName, linearStatusName: p.linearStatusName,
        linearStatusType: p.linearStatusType, labelsJson: JSON.stringify(p.labels),
        bmStatus: p.bmStatus, attemptCount: p.attemptCount, maxAttempts: p.maxAttempts,
        createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt), completedAt: d(p.completedAt),
      };
      await db.insert(tables.tickets).values(row).onConflictDoUpdate({
        target: tables.tickets.id,
        set: { ...row, createdAt: sql`${tables.tickets.createdAt}` },
      });
    },

    async upsertWorker(p) {
      const row = {
        id: p.id, name: p.name, status: p.status, currentRunId: p.currentRunId,
        lastHeartbeatAt: d(p.lastHeartbeatAt), startedAt: new Date(p.startedAt), updatedAt: new Date(p.updatedAt),
      };
      await db.insert(tables.workers).values(row).onConflictDoUpdate({ target: tables.workers.id, set: row });
    },

    async upsertRun(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, attemptNumber: p.attemptNumber, workerId: p.workerId,
        trigger: p.trigger, status: p.status, contextJson: p.contextJson,
        startedAt: d(p.startedAt), endedAt: d(p.endedAt), stopReason: p.stopReason, error: p.error,
        createdAt: new Date(p.createdAt),
      };
      await db.insert(tables.runs).values(row).onConflictDoUpdate({
        target: tables.runs.id,
        set: {
          ...row,
          // createdAt is immutable after insert; startedAt is set-once (never reset to null by a later transition).
          createdAt: sql`${tables.runs.createdAt}`,
          startedAt: sql`coalesce(${tables.runs.startedAt}, excluded.started_at)`,
        },
      });
    },

    async upsertPullRequest(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, number: p.number, title: p.title, headRef: p.headRef,
        state: p.state, draft: p.draft, merged: p.merged, url: p.url, lastRunId: p.lastRunId,
        createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
      };
      await db.insert(tables.pullRequests).values(row).onConflictDoUpdate({ target: tables.pullRequests.id, set: row });
    },

    async upsertCiRun(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, runId: p.runId, prId: p.prId, status: p.status,
        url: p.url, summary: p.summary, createdAt: new Date(p.createdAt), completedAt: d(p.completedAt),
      };
      await db.insert(tables.ciRuns).values(row).onConflictDoUpdate({ target: tables.ciRuns.id, set: row });
    },

    async insertEvent(p) {
      await db.insert(tables.events).values({
        id: globalThis.crypto.randomUUID(),
        ticketId: p.ticketId, runId: p.runId, workerId: p.workerId, source: p.source,
        type: p.type, summary: p.summary, payloadJson: p.payloadJson, createdAt: new Date(p.createdAt),
      });
    },
  };
}

export function createWriter(handle: DbHandle): Writer {
  return buildWriter(handle.db, handle.schema);
}
