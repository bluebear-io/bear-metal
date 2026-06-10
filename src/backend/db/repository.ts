import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Ticket, Run, PullRequestRow, CiRun, CiCheck, ReviewThreadRow, EventRow, Worker } from "./types.js";
import { estimateCostUsd, modelFamily } from "../pricing.js";

type Db = BetterSQLite3Database<typeof schema>;
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

export function listTickets(db: Db, filter?: { bmStatus?: Ticket["bmStatus"] }): TicketListItem[] {
  const where = filter?.bmStatus ? eq(schema.tickets.bmStatus, filter.bmStatus) : undefined;
  const ticketRows = db.select().from(schema.tickets).where(where).orderBy(desc(schema.tickets.createdAt)).all();
  if (ticketRows.length === 0) return [];

  // Batch the per-ticket joins into one query per child table; group + reduce in JS.
  // Order matters: each `latest*` pick relies on the ORDER BY matching what the
  // previous per-ticket query did (run: attemptNumber desc then createdAt desc;
  // PR: updatedAt desc; CI: createdAt desc). The first row seen per ticketId wins.
  const ticketIds = ticketRows.map((t) => t.id);
  const runRows = db.select().from(schema.runs).where(inArray(schema.runs.ticketId, ticketIds))
    .orderBy(desc(schema.runs.attemptNumber), desc(schema.runs.createdAt)).all();
  const prRows = db.select().from(schema.pullRequests).where(inArray(schema.pullRequests.ticketId, ticketIds))
    .orderBy(desc(schema.pullRequests.updatedAt)).all();
  const ciRows = db.select().from(schema.ciRuns).where(inArray(schema.ciRuns.ticketId, ticketIds))
    .orderBy(desc(schema.ciRuns.createdAt)).all();

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
      latestPr: latestPrRow ? { number: latestPrRow.number, url: latestPrRow.url, state: latestPrRow.state, merged: latestPrRow.merged } : null,
      // latestCiStatus = the ticket's most recent CI outcome overall (not scoped to latestPr); a ticket reuses one branch/PR so this is the dashboard's "current CI state".
      latestCiStatus: latestCi?.status ?? null,
    };
  });
}

export function getTicketDetail(db: Db, id: string): TicketDetail | null {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get();
  if (!ticket) return null;

  const runRows = db.select().from(schema.runs).where(eq(schema.runs.ticketId, id)).orderBy(schema.runs.attemptNumber).all();
  const workersById = new Map(db.select().from(schema.workers).all().map((w) => [w.id, w]));
  const runs: RunWithUsage[] = runRows.map((r) => ({
    ...r,
    worker: r.workerId ? workersById.get(r.workerId) ?? null : null,
    estimatedCostUsd: estimateCostUsd(r.provider, r.modelName, r.promptTokens, r.completionTokens),
  }));

  const prRows = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.ticketId, id)).orderBy(desc(schema.pullRequests.updatedAt)).all();
  const threadRows = prRows.length === 0
    ? []
    : db.select().from(schema.reviewThreads).where(inArray(schema.reviewThreads.prId, prRows.map((p) => p.id))).orderBy(schema.reviewThreads.updatedAt).all();
  const threadsByPr = new Map<string, ReviewThreadRow[]>();
  for (const t of threadRows) {
    const list = threadsByPr.get(t.prId) ?? [];
    list.push(t);
    threadsByPr.set(t.prId, list);
  }
  const pullRequests: PullRequestWithThreads[] = prRows.map((pr) => ({
    ...pr,
    reviewThreads: threadsByPr.get(pr.id) ?? [],
  }));

  const ciRunRows = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, id)).orderBy(schema.ciRuns.createdAt).all();
  const checkRows = ciRunRows.length === 0
    ? []
    : db.select().from(schema.ciChecks).where(inArray(schema.ciChecks.ciRunId, ciRunRows.map((c) => c.id))).orderBy(schema.ciChecks.createdAt).all();
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
  const events = db.select().from(schema.events).where(eq(schema.events.ticketId, id)).orderBy(schema.events.createdAt).all();

  return { ticket, runs, pullRequests, ciRuns, events };
}

/**
 * Aggregate efficacy stats per `(provider, model_name)` for the model comparison view.
 * Only runs with a recorded `model_name` participate — running/dispatched rows are skipped.
 */
export function listModelComparison(db: Db): ModelComparisonRow[] {
  const rows = db
    .select()
    .from(schema.runs)
    .where(and(isNotNull(schema.runs.modelName), isNotNull(schema.runs.provider)))
    .all();

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
}

export function listWorkers(db: Db, options: ListWorkerOptions = {}): WorkerListItem[] {
  const now = options.now ?? new Date();
  const workers = db.select().from(schema.workers).all();

  // Batch the current-run + current-ticket lookups. Most operator dashboards
  // only run a handful of workers, but the per-row round-trip pattern showed up
  // in DEN-2321 review — collapse it to two queries regardless.
  const runIds = workers.map((w) => w.currentRunId).filter((id): id is string => id !== null);
  const runById = new Map<string, Run>();
  if (runIds.length > 0) {
    for (const r of db.select().from(schema.runs).where(inArray(schema.runs.id, runIds)).all()) {
      runById.set(r.id, r);
    }
  }
  const ticketIds = Array.from(new Set(Array.from(runById.values()).map((r) => r.ticketId)));
  const ticketById = new Map<string, Ticket>();
  if (ticketIds.length > 0) {
    for (const t of db.select().from(schema.tickets).where(inArray(schema.tickets.id, ticketIds)).all()) {
      ticketById.set(t.id, t);
    }
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
}
