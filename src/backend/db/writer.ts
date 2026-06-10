import { eq, sql } from "drizzle-orm";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload,
  CiCheckPayload, ReviewThreadPayload, RunToolCallPayload, EventPayload,
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
  /** Replace the set of failing checks attached to a CI run — keeps rows in sync with the latest poll. */
  replaceCiChecksForRun(ciRunId: string, payloads: CiCheckPayload[]): Promise<void>;
  /** Replace the set of review threads attached to a PR — mirrors GitHub's current thread set. */
  replaceReviewThreadsForPr(prId: string, payloads: ReviewThreadPayload[]): Promise<void>;
  /** Replace the tool-call timeline rows attached to a run (DEN-2311). */
  replaceRunToolCallsForRun(runId: string, payloads: RunToolCallPayload[]): Promise<void>;
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
export function createWriter(handle: DbHandle): Writer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = handle.db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = handle.schema;

  const upsertCiCheck = async (p: CiCheckPayload): Promise<void> => {
    const row = {
      id: p.id, ciRunId: p.ciRunId, source: p.source, externalId: p.externalId,
      name: p.name, conclusion: p.conclusion, detailsUrl: p.detailsUrl, summary: p.summary,
      annotationsJson: p.annotationsJson, createdAt: new Date(p.createdAt),
    };
    await db.insert(t.ciChecks).values(row).onConflictDoUpdate({ target: t.ciChecks.id, set: row });
  };

  const upsertReviewThread = async (p: ReviewThreadPayload): Promise<void> => {
    const row = {
      id: p.id, prId: p.prId, path: p.path, line: p.line, isResolved: p.isResolved,
      commentsJson: p.commentsJson, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
    };
    await db.insert(t.reviewThreads).values(row).onConflictDoUpdate({ target: t.reviewThreads.id, set: row });
  };

  return {
    async upsertTicket(p) {
      const row = {
        id: p.id, identifier: p.identifier, title: p.title, description: p.description,
        url: p.url, branchName: p.branchName, linearStatusName: p.linearStatusName,
        linearStatusType: p.linearStatusType, labelsJson: JSON.stringify(p.labels),
        bmStatus: p.bmStatus, attemptCount: p.attemptCount, maxAttempts: p.maxAttempts,
        createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt), completedAt: d(p.completedAt),
      };
      await db.insert(t.tickets).values(row).onConflictDoUpdate({
        target: t.tickets.id,
        set: { ...row, createdAt: sql`${t.tickets.createdAt}` },
      });
    },

    async upsertWorker(p) {
      const row = {
        id: p.id, name: p.name, status: p.status, currentRunId: p.currentRunId,
        lastHeartbeatAt: d(p.lastHeartbeatAt), startedAt: new Date(p.startedAt), updatedAt: new Date(p.updatedAt),
      };
      await db.insert(t.workers).values(row).onConflictDoUpdate({ target: t.workers.id, set: row });
    },

    async upsertRun(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, attemptNumber: p.attemptNumber, workerId: p.workerId,
        trigger: p.trigger, status: p.status, contextJson: p.contextJson,
        startedAt: d(p.startedAt), endedAt: d(p.endedAt), stopReason: p.stopReason, error: p.error,
        promptTokens: p.promptTokens, completionTokens: p.completionTokens,
        modelName: p.modelName, provider: p.provider,
        createdAt: new Date(p.createdAt),
      };
      await db.insert(t.runs).values(row).onConflictDoUpdate({
        target: t.runs.id,
        set: {
          ...row,
          // createdAt is immutable after insert; startedAt and the usage fields are set-once —
          // a later transition (e.g. an out-of-order or duplicate status update) must never
          // wipe out previously-recorded values by sending null.
          createdAt: sql`${t.runs.createdAt}`,
          startedAt: sql`coalesce(${t.runs.startedAt}, excluded.started_at)`,
          promptTokens: sql`coalesce(excluded.prompt_tokens, ${t.runs.promptTokens})`,
          completionTokens: sql`coalesce(excluded.completion_tokens, ${t.runs.completionTokens})`,
          modelName: sql`coalesce(excluded.model_name, ${t.runs.modelName})`,
          provider: sql`coalesce(excluded.provider, ${t.runs.provider})`,
        },
      });
    },

    async upsertPullRequest(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, number: p.number, title: p.title, headRef: p.headRef,
        state: p.state, draft: p.draft, merged: p.merged, url: p.url, lastRunId: p.lastRunId,
        createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
      };
      await db.insert(t.pullRequests).values(row).onConflictDoUpdate({ target: t.pullRequests.id, set: row });
    },

    async upsertCiRun(p) {
      const row = {
        id: p.id, ticketId: p.ticketId, runId: p.runId, prId: p.prId, status: p.status,
        url: p.url, summary: p.summary, createdAt: new Date(p.createdAt), completedAt: d(p.completedAt),
      };
      await db.insert(t.ciRuns).values(row).onConflictDoUpdate({ target: t.ciRuns.id, set: row });
    },

    async replaceCiChecksForRun(ciRunId, payloads) {
      // Drizzle's transaction-callback signature is sync on better-sqlite3 and async on pg —
      // can't share one closure across dialects. Same pattern as backfill/writer.ts.
      if (handle.dialect === "sqlite") {
        handle.db.transaction((tx) => {
          tx.delete(t.ciChecks).where(eq(t.ciChecks.ciRunId, ciRunId)).run();
          for (const p of payloads) {
            const row = {
              id: p.id, ciRunId: p.ciRunId, source: p.source, externalId: p.externalId,
              name: p.name, conclusion: p.conclusion, detailsUrl: p.detailsUrl, summary: p.summary,
              annotationsJson: p.annotationsJson, createdAt: new Date(p.createdAt),
            };
            tx.insert(t.ciChecks).values(row).onConflictDoUpdate({ target: t.ciChecks.id, set: row }).run();
          }
        });
        return;
      }
      await handle.db.transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny: any = tx;
        await txAny.delete(t.ciChecks).where(eq(t.ciChecks.ciRunId, ciRunId));
        for (const p of payloads) {
          await upsertCiCheck(p);
        }
      });
    },

    async replaceReviewThreadsForPr(prId, payloads) {
      if (handle.dialect === "sqlite") {
        handle.db.transaction((tx) => {
          tx.delete(t.reviewThreads).where(eq(t.reviewThreads.prId, prId)).run();
          for (const p of payloads) {
            const row = {
              id: p.id, prId: p.prId, path: p.path, line: p.line, isResolved: p.isResolved,
              commentsJson: p.commentsJson, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
            };
            tx.insert(t.reviewThreads).values(row).onConflictDoUpdate({ target: t.reviewThreads.id, set: row }).run();
          }
        });
        return;
      }
      await handle.db.transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny: any = tx;
        await txAny.delete(t.reviewThreads).where(eq(t.reviewThreads.prId, prId));
        for (const p of payloads) {
          await upsertReviewThread(p);
        }
      });
    },

    async replaceRunToolCallsForRun(runId, payloads) {
      // Same dialect split as replaceCiChecksForRun/replaceReviewThreadsForPr: drizzle's
      // transaction-callback signature is sync on better-sqlite3 and async on pg.
      const upsertRow = (p: RunToolCallPayload) => ({
        id: p.id, runId: p.runId, sequence: p.sequence, toolName: p.toolName,
        argsJson: p.argsJson, resultText: p.resultText, resultStatus: p.resultStatus,
        outputSize: p.outputSize, thoughtText: p.thoughtText, createdAt: new Date(p.createdAt),
      });
      if (handle.dialect === "sqlite") {
        handle.db.transaction((tx) => {
          tx.delete(t.runToolCalls).where(eq(t.runToolCalls.runId, runId)).run();
          for (const p of payloads) {
            const row = upsertRow(p);
            tx.insert(t.runToolCalls).values(row).onConflictDoUpdate({ target: t.runToolCalls.id, set: row }).run();
          }
        });
        return;
      }
      await handle.db.transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny: any = tx;
        await txAny.delete(t.runToolCalls).where(eq(t.runToolCalls.runId, runId));
        for (const p of payloads) {
          const row = upsertRow(p);
          await txAny.insert(t.runToolCalls).values(row).onConflictDoUpdate({ target: t.runToolCalls.id, set: row });
        }
      });
    },

    async insertEvent(p) {
      await db.insert(t.events).values({
        id: globalThis.crypto.randomUUID(),
        ticketId: p.ticketId, runId: p.runId, workerId: p.workerId, source: p.source,
        type: p.type, summary: p.summary, payloadJson: p.payloadJson, createdAt: new Date(p.createdAt),
      });
    },
  };
}
