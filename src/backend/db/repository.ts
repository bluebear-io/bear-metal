import { desc, eq } from "drizzle-orm";
import type { Ticket, Run, PullRequestRow, CiRun, EventRow, Worker } from "./types.js";
import type { DbHandle } from "./client.js";

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const WORKER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export interface LatestRunSummary {
  id: string;
  attemptNumber: number;
  status: Run["status"];
  trigger: Run["trigger"];
  workerId: string | null;
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

export interface TicketListItem extends Ticket {
  latestRun: LatestRunSummary | null;
  latestPr: { number: number; url: string; state: PullRequestRow["state"]; merged: boolean } | null;
  latestCiStatus: "running" | "passed" | "failed" | null;
}

export interface TicketDetail {
  ticket: Ticket;
  runs: (Run & { worker: Worker | null })[];
  pullRequests: PullRequestRow[];
  ciRuns: CiRun[];
  events: EventRow[];
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

interface ListWorkerOptions {
  now?: Date;
}

/** Dialect-agnostic read interface backing the dashboard's GET routes. */
export interface Repository {
  listTickets(filter?: { bmStatus?: Ticket["bmStatus"] }): Promise<TicketListItem[]>;
  getTicketDetail(id: string): Promise<TicketDetail | null>;
  listWorkers(options?: ListWorkerOptions): Promise<WorkerListItem[]>;
}

function toLatestRunSummary(run: Run): LatestRunSummary {
  return {
    id: run.id,
    attemptNumber: run.attemptNumber,
    status: run.status,
    trigger: run.trigger,
    workerId: run.workerId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    createdAt: run.createdAt,
  };
}

function elapsedSince(now: Date, then: Date | null): number | null {
  if (!then) return null;
  return Math.max(0, now.getTime() - then.getTime());
}

/**
 * Drizzle's sqlite query builder is sync (`.all()`/`.get()` return rows directly); the pg builder
 * is async (returns Promises). Both `await await sync` and `await Promise` resolve to the row data,
 * so the implementation is written in await-everywhere style with `any` typing internally — the
 * schema-pg parity test guarantees the row shapes match across dialects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRepository(db: any, t: any): Repository {
  return {
    async listTickets(filter) {
      const where = filter?.bmStatus ? eq(t.tickets.bmStatus, filter.bmStatus) : undefined;
      const ticketRows: Ticket[] = await db.select().from(t.tickets).where(where).orderBy(desc(t.tickets.createdAt));
      const result: TicketListItem[] = [];
      for (const ticket of ticketRows) {
        const latestRunRow: Run | undefined = (await db.select().from(t.runs).where(eq(t.runs.ticketId, ticket.id)).orderBy(desc(t.runs.attemptNumber), desc(t.runs.createdAt)).limit(1))[0];
        const prs: PullRequestRow[] = await db.select().from(t.pullRequests).where(eq(t.pullRequests.ticketId, ticket.id)).orderBy(desc(t.pullRequests.updatedAt));
        const latestPrRow = prs[0] ?? null;
        const ci: CiRun[] = await db.select().from(t.ciRuns).where(eq(t.ciRuns.ticketId, ticket.id)).orderBy(desc(t.ciRuns.createdAt));
        result.push({
          ...ticket,
          latestRun: latestRunRow ? toLatestRunSummary(latestRunRow) : null,
          latestPr: latestPrRow
            ? { number: latestPrRow.number, url: latestPrRow.url, state: latestPrRow.state, merged: latestPrRow.merged }
            : null,
          // latestCiStatus = the ticket's most recent CI outcome overall (not scoped to latestPr); a ticket reuses one branch/PR so this is the dashboard's "current CI state".
          latestCiStatus: ci[0]?.status ?? null,
        });
      }
      return result;
    },

    async getTicketDetail(id) {
      const ticketRow: Ticket | undefined = (await db.select().from(t.tickets).where(eq(t.tickets.id, id)).limit(1))[0];
      if (!ticketRow) return null;

      const runRows: Run[] = await db.select().from(t.runs).where(eq(t.runs.ticketId, id)).orderBy(t.runs.attemptNumber);
      const workerRows: Worker[] = await db.select().from(t.workers);
      const workersById = new Map(workerRows.map((w) => [w.id, w]));
      const runs = runRows.map((r) => ({ ...r, worker: r.workerId ? workersById.get(r.workerId) ?? null : null }));

      const pullRequests: PullRequestRow[] = await db.select().from(t.pullRequests).where(eq(t.pullRequests.ticketId, id)).orderBy(desc(t.pullRequests.updatedAt));
      const ciRuns: CiRun[] = await db.select().from(t.ciRuns).where(eq(t.ciRuns.ticketId, id)).orderBy(t.ciRuns.createdAt);
      const events: EventRow[] = await db.select().from(t.events).where(eq(t.events.ticketId, id)).orderBy(t.events.createdAt);

      return { ticket: ticketRow, runs, pullRequests, ciRuns, events };
    },

    async listWorkers(options = {}) {
      const now = options.now ?? new Date();
      const workers: Worker[] = await db.select().from(t.workers);
      const result: WorkerListItem[] = [];
      for (const w of workers) {
        let currentTicketIdentifier: string | null = null;
        let currentTicketTitle: string | null = null;
        let currentRun: CurrentRunSummary | null = null;
        if (w.currentRunId) {
          const run: Run | undefined = (await db.select().from(t.runs).where(eq(t.runs.id, w.currentRunId)).limit(1))[0];
          if (run) {
            const ticket: Ticket | undefined = (await db.select().from(t.tickets).where(eq(t.tickets.id, run.ticketId)).limit(1))[0];
            currentTicketIdentifier = ticket?.identifier ?? null;
            currentTicketTitle = ticket?.title ?? null;
            if (ticket) {
              const runtimeMs = run.endedAt ? elapsedSince(run.endedAt, run.startedAt) : elapsedSince(now, run.startedAt);
              currentRun = {
                ...toLatestRunSummary(run),
                ticketId: ticket.id,
                ticketIdentifier: ticket.identifier,
                ticketTitle: ticket.title,
                runtimeMs,
              };
            }
          }
        }
        const heartbeatAgeMs = elapsedSince(now, w.lastHeartbeatAt);
        const isTimedOut = currentRun !== null && currentRun.runtimeMs !== null && currentRun.endedAt === null && currentRun.runtimeMs >= WORKER_RUN_TIMEOUT_MS;
        result.push({
          ...w,
          currentTicketIdentifier,
          currentTicketTitle,
          currentRun,
          heartbeatAgeMs,
          isDead: w.status === "dead",
          isHeartbeatStale: heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS,
          isTimedOut,
        });
      }
      return result;
    },
  };
}

export function createRepository(handle: DbHandle): Repository {
  return buildRepository(handle.db, handle.schema);
}
