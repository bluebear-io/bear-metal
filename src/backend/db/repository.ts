import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type {
  Ticket, Run, PullRequestRow, CiRun, CiCheck, ReviewThreadRow, RunToolCallRow, EventRow, Worker,
} from "./types.js";
import type { DbHandle } from "./client.js";
import { estimateCostUsd, modelFamily } from "../pricing.js";

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

/** A CI run with its individual failing checks (test/lint/type/etc.) attached. */
export interface CiRunWithChecks extends CiRun {
  checks: CiCheck[];
}

/** A PR row with its review threads (resolved + unresolved) attached. */
export interface PullRequestWithThreads extends PullRequestRow {
  reviewThreads: ReviewThreadRow[];
}

/** Per-run usage + computed cost — null when usage isn't recorded for the run. */
export interface RunWithUsage extends Run {
  worker: Worker | null;
  /** Estimated cost in USD; null when the model pricing isn't in the table or tokens weren't recorded. */
  estimatedCostUsd: number | null;
  /** Ordered tool-call timeline for the "thought process" visualizer (DEN-2311). */
  toolCalls: RunToolCallRow[];
}

export interface TicketDetail {
  ticket: Ticket;
  runs: RunWithUsage[];
  pullRequests: PullRequestWithThreads[];
  ciRuns: CiRunWithChecks[];
  events: EventRow[];
}

export interface ModelComparisonRow {
  family: "claude" | "gpt" | "gemini" | "other";
  provider: string;
  modelName: string;
  /** All terminal runs counted (succeeded + failed + timed_out + crashed). */
  totalRuns: number;
  succeededRuns: number;
  /** succeededRuns / totalRuns, 0..1. */
  successRate: number;
  /** Average wall-clock seconds for runs that have both started_at and ended_at. */
  avgDurationSeconds: number | null;
  /** Number of runs that contributed to `avgDurationSeconds` (i.e. had both started_at and ended_at). */
  runsWithDuration: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Sum of estimated cost across all runs of this model (USD). */
  totalCostUsd: number;
  /** Mean cost per run (USD). */
  avgCostUsd: number;
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
  /** Aggregate efficacy stats per (provider, model_name). Skips runs with no recorded model. */
  listModelComparison(): Promise<ModelComparisonRow[]>;
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
export function createRepository(handle: DbHandle): Repository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = handle.db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t: any = handle.schema;

  return {
    async listTickets(filter) {
      const where = filter?.bmStatus ? eq(t.tickets.bmStatus, filter.bmStatus) : undefined;
      const ticketRows: Ticket[] = await db.select().from(t.tickets).where(where).orderBy(desc(t.tickets.createdAt));
      if (ticketRows.length === 0) return [];

      // One query per child table; group + reduce in JS. Order matters: each `latest*` pick relies
      // on ORDER BY (run: attemptNumber desc then createdAt desc; PR: updatedAt desc; CI: createdAt desc).
      // The first row seen per ticketId wins.
      const ticketIds = ticketRows.map((row) => row.id);
      const runRows: Run[] = await db.select().from(t.runs).where(inArray(t.runs.ticketId, ticketIds))
        .orderBy(desc(t.runs.attemptNumber), desc(t.runs.createdAt));
      const prRows: PullRequestRow[] = await db.select().from(t.pullRequests).where(inArray(t.pullRequests.ticketId, ticketIds))
        .orderBy(desc(t.pullRequests.updatedAt));
      const ciRows: CiRun[] = await db.select().from(t.ciRuns).where(inArray(t.ciRuns.ticketId, ticketIds))
        .orderBy(desc(t.ciRuns.createdAt));

      const latestRunByTicket = new Map<string, Run>();
      for (const r of runRows) if (!latestRunByTicket.has(r.ticketId)) latestRunByTicket.set(r.ticketId, r);
      const latestPrByTicket = new Map<string, PullRequestRow>();
      for (const p of prRows) if (!latestPrByTicket.has(p.ticketId)) latestPrByTicket.set(p.ticketId, p);
      const latestCiByTicket = new Map<string, CiRun>();
      for (const c of ciRows) if (!latestCiByTicket.has(c.ticketId)) latestCiByTicket.set(c.ticketId, c);

      return ticketRows.map((ticket) => {
        const latestRunRow = latestRunByTicket.get(ticket.id) ?? null;
        const latestPrRow = latestPrByTicket.get(ticket.id) ?? null;
        const latestCi = latestCiByTicket.get(ticket.id) ?? null;
        return {
          ...ticket,
          latestRun: latestRunRow ? toLatestRunSummary(latestRunRow) : null,
          latestPr: latestPrRow
            ? { number: latestPrRow.number, url: latestPrRow.url, state: latestPrRow.state, merged: latestPrRow.merged }
            : null,
          // latestCiStatus = the ticket's most recent CI outcome overall (not scoped to latestPr);
          // a ticket reuses one branch/PR so this is the dashboard's "current CI state".
          latestCiStatus: latestCi?.status ?? null,
        };
      });
    },

    async getTicketDetail(id) {
      const ticketRow: Ticket | undefined = (await db.select().from(t.tickets).where(eq(t.tickets.id, id)).limit(1))[0];
      if (!ticketRow) return null;

      const runRows: Run[] = await db.select().from(t.runs).where(eq(t.runs.ticketId, id)).orderBy(t.runs.attemptNumber);
      const workerRows: Worker[] = await db.select().from(t.workers);
      const workersById = new Map(workerRows.map((w) => [w.id, w]));
      const toolCallRows: RunToolCallRow[] = runRows.length === 0
        ? []
        : await db.select().from(t.runToolCalls).where(inArray(t.runToolCalls.runId, runRows.map((r) => r.id))).orderBy(t.runToolCalls.runId, t.runToolCalls.sequence);
      const toolCallsByRun = new Map<string, RunToolCallRow[]>();
      for (const tc of toolCallRows) {
        const list = toolCallsByRun.get(tc.runId) ?? [];
        list.push(tc);
        toolCallsByRun.set(tc.runId, list);
      }
      const runs: RunWithUsage[] = runRows.map((r) => ({
        ...r,
        worker: r.workerId ? workersById.get(r.workerId) ?? null : null,
        estimatedCostUsd: estimateCostUsd(r.provider, r.modelName, r.promptTokens, r.completionTokens),
        toolCalls: toolCallsByRun.get(r.id) ?? [],
      }));

      const prRows: PullRequestRow[] = await db.select().from(t.pullRequests).where(eq(t.pullRequests.ticketId, id)).orderBy(desc(t.pullRequests.updatedAt));
      const threadRows: ReviewThreadRow[] = prRows.length === 0
        ? []
        : await db.select().from(t.reviewThreads).where(inArray(t.reviewThreads.prId, prRows.map((p) => p.id))).orderBy(t.reviewThreads.updatedAt);
      const threadsByPr = new Map<string, ReviewThreadRow[]>();
      for (const thread of threadRows) {
        const list = threadsByPr.get(thread.prId) ?? [];
        list.push(thread);
        threadsByPr.set(thread.prId, list);
      }
      const pullRequests: PullRequestWithThreads[] = prRows.map((pr) => ({
        ...pr,
        reviewThreads: threadsByPr.get(pr.id) ?? [],
      }));

      const ciRunRows: CiRun[] = await db.select().from(t.ciRuns).where(eq(t.ciRuns.ticketId, id)).orderBy(t.ciRuns.createdAt);
      const checkRows: CiCheck[] = ciRunRows.length === 0
        ? []
        : await db.select().from(t.ciChecks).where(inArray(t.ciChecks.ciRunId, ciRunRows.map((c) => c.id))).orderBy(t.ciChecks.createdAt);
      const checksByCiRun = new Map<string, CiCheck[]>();
      for (const c of checkRows) {
        const list = checksByCiRun.get(c.ciRunId) ?? [];
        list.push(c);
        checksByCiRun.set(c.ciRunId, list);
      }
      const ciRuns: CiRunWithChecks[] = ciRunRows.map((ci) => ({
        ...ci,
        checks: checksByCiRun.get(ci.id) ?? [],
      }));

      const events: EventRow[] = await db.select().from(t.events).where(eq(t.events.ticketId, id)).orderBy(t.events.createdAt);

      return { ticket: ticketRow, runs, pullRequests, ciRuns, events };
    },

    async listModelComparison() {
      const rows: Run[] = await db.select().from(t.runs).where(and(isNotNull(t.runs.modelName), isNotNull(t.runs.provider)));

      const buckets = new Map<string, {
        provider: string;
        modelName: string;
        totalRuns: number;
        succeededRuns: number;
        durations: number[];
        promptTokens: number;
        completionTokens: number;
        costSum: number;
      }>();

      for (const r of rows) {
        const provider = r.provider ?? "";
        const modelName = r.modelName ?? "";
        if (!provider || !modelName) continue;
        const key = `${provider}::${modelName}`;
        let b = buckets.get(key);
        if (!b) {
          b = { provider, modelName, totalRuns: 0, succeededRuns: 0, durations: [], promptTokens: 0, completionTokens: 0, costSum: 0 };
          buckets.set(key, b);
        }
        b.totalRuns += 1;
        if (r.status === "succeeded") b.succeededRuns += 1;
        if (r.startedAt && r.endedAt) {
          const seconds = Math.max(0, (r.endedAt.getTime() - r.startedAt.getTime()) / 1000);
          b.durations.push(seconds);
        }
        b.promptTokens += r.promptTokens ?? 0;
        b.completionTokens += r.completionTokens ?? 0;
        const cost = estimateCostUsd(provider, modelName, r.promptTokens, r.completionTokens);
        if (cost !== null) b.costSum += cost;
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
          totalCostUsd: b.costSum,
          avgCostUsd: b.totalRuns > 0 ? b.costSum / b.totalRuns : 0,
        });
      }
      // Sort by total cost descending so the most-used models surface first.
      result.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
      return result;
    },

    async listWorkers(options = {}) {
      const now = options.now ?? new Date();
      const workers: Worker[] = await db.select().from(t.workers);

      // Batch the current-run + current-ticket lookups to avoid N+1.
      const runIds = workers.map((w) => w.currentRunId).filter((id): id is string => id !== null);
      const runById = new Map<string, Run>();
      if (runIds.length > 0) {
        const runRows: Run[] = await db.select().from(t.runs).where(inArray(t.runs.id, runIds));
        for (const r of runRows) runById.set(r.id, r);
      }
      const ticketIds = Array.from(new Set(Array.from(runById.values()).map((r) => r.ticketId)));
      const ticketById = new Map<string, Ticket>();
      if (ticketIds.length > 0) {
        const ticketRows: Ticket[] = await db.select().from(t.tickets).where(inArray(t.tickets.id, ticketIds));
        for (const ticket of ticketRows) ticketById.set(ticket.id, ticket);
      }

      return workers.map((w) => {
        let currentTicketIdentifier: string | null = null;
        let currentTicketTitle: string | null = null;
        let currentRun: CurrentRunSummary | null = null;
        if (w.currentRunId) {
          const run = runById.get(w.currentRunId);
          if (run) {
            const ticket = ticketById.get(run.ticketId);
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
        return {
          ...w,
          currentTicketIdentifier,
          currentTicketTitle,
          currentRun,
          heartbeatAgeMs,
          isDead: w.status === "dead",
          isHeartbeatStale: heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS,
          isTimedOut,
        };
      });
    },
  };
}
