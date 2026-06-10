import { and, asc, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
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

export type WorkerStatusValue = Worker["status"];

export interface WorkerTimelineSegment {
  status: WorkerStatusValue;
  startAt: Date;
  endAt: Date;
}

export interface WorkerTimeline {
  id: string;
  name: string;
  status: WorkerStatusValue;
  segments: WorkerTimelineSegment[];
}

export interface WorkerTimelineResponse {
  windowStart: Date;
  windowEnd: Date;
  hours: number;
  workers: WorkerTimeline[];
}

export const WORKER_TIMELINE_MIN_HOURS = 1;
export const WORKER_TIMELINE_MAX_HOURS = 72;
export const WORKER_TIMELINE_DEFAULT_HOURS = 24;

interface ListWorkerTimelineOptions {
  hours?: number;
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

  return ticketRows.map((ticket) => {
    const latestRunRow = db.select().from(schema.runs).where(eq(schema.runs.ticketId, ticket.id)).orderBy(desc(schema.runs.attemptNumber), desc(schema.runs.createdAt)).get();
    const prs = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.ticketId, ticket.id)).orderBy(desc(schema.pullRequests.updatedAt)).all();
    const latestPrRow = prs[0] ?? null;
    const ci = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, ticket.id)).orderBy(desc(schema.ciRuns.createdAt)).all();
    return {
      ...ticket,
      latestRun: latestRunRow ? toLatestRunSummary(latestRunRow) : null,
      latestPr: latestPrRow ? { number: latestPrRow.number, url: latestPrRow.url, state: latestPrRow.state, merged: latestPrRow.merged } : null,
      // latestCiStatus = the ticket's most recent CI outcome overall (not scoped to latestPr); a ticket reuses one branch/PR so this is the dashboard's "current CI state".
      latestCiStatus: ci[0]?.status ?? null,
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
  const pullRequests: PullRequestWithThreads[] = prRows.map((pr) => ({
    ...pr,
    reviewThreads: db.select().from(schema.reviewThreads).where(eq(schema.reviewThreads.prId, pr.id)).orderBy(schema.reviewThreads.updatedAt).all(),
  }));
  const ciRunRows = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, id)).orderBy(schema.ciRuns.createdAt).all();
  const ciRuns: CiRunWithChecks[] = ciRunRows.map((ci) => ({
    ...ci,
    checks: db.select().from(schema.ciChecks).where(eq(schema.ciChecks.ciRunId, ci.id)).orderBy(schema.ciChecks.createdAt).all(),
  }));
  const events = db.select().from(schema.events).where(eq(schema.events.ticketId, id)).orderBy(schema.events.createdAt).all();

  return { ticket, runs, pullRequests, ciRuns, events };
}

/**
 * Aggregate efficacy stats per `(provider, model_name)` for the model comparison view (DEN-2313).
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
  return workers.map((w) => {
    let currentTicketIdentifier: string | null = null;
    let currentTicketTitle: string | null = null;
    let currentRun: CurrentRunSummary | null = null;
    if (w.currentRunId) {
      const run = db.select().from(schema.runs).where(eq(schema.runs.id, w.currentRunId)).get();
      if (run) {
        const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, run.ticketId)).get();
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

/**
 * Build a per-worker Gantt timeline of status segments inside the [now - hours, now] window.
 *
 * The transitions table is append-only. To render a segment that crosses the window's left
 * edge we also need the most recent transition strictly before `windowStart` (the worker's
 * status as the window opens). Each segment ends at the next transition's timestamp or, for
 * the last segment, at `now`.
 */
export function listWorkerTimeline(db: Db, options: ListWorkerTimelineOptions = {}): WorkerTimelineResponse {
  const now = options.now ?? new Date();
  const hours = clampTimelineHours(options.hours ?? WORKER_TIMELINE_DEFAULT_HOURS);
  const windowStart = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const workers = db.select().from(schema.workers).all();
  const result: WorkerTimeline[] = workers.map((w) => {
    // Most recent transition strictly before the window — gives us the status at windowStart.
    const prior = db.select()
      .from(schema.workerStatusTransitions)
      .where(and(eq(schema.workerStatusTransitions.workerId, w.id), lt(schema.workerStatusTransitions.changedAt, windowStart)))
      .orderBy(desc(schema.workerStatusTransitions.changedAt))
      .limit(1)
      .get();

    const inside = db.select()
      .from(schema.workerStatusTransitions)
      .where(and(eq(schema.workerStatusTransitions.workerId, w.id), gte(schema.workerStatusTransitions.changedAt, windowStart)))
      .orderBy(asc(schema.workerStatusTransitions.changedAt))
      .all();

    const points: { status: WorkerStatusValue; at: Date }[] = [];
    if (prior) {
      points.push({ status: prior.status, at: windowStart });
    }
    for (const t of inside) {
      const at = t.changedAt < windowStart ? windowStart : t.changedAt;
      points.push({ status: t.status, at });
    }

    // No transitions ever recorded for this worker — fall back to the live status so the
    // chart still shows something. This only happens for workers seeded before transition
    // recording was introduced.
    if (points.length === 0) {
      points.push({ status: w.status, at: windowStart });
    }

    const segments: WorkerTimelineSegment[] = [];
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const next = points[i + 1];
      const startAt = point.at < windowStart ? windowStart : point.at;
      const endAt = next ? next.at : now;
      if (endAt.getTime() <= startAt.getTime()) continue;
      segments.push({ status: point.status, startAt, endAt });
    }

    return { id: w.id, name: w.name, status: w.status, segments };
  });

  return { windowStart, windowEnd: now, hours, workers: result };
}

export function clampTimelineHours(hours: number): number {
  if (!Number.isFinite(hours)) return WORKER_TIMELINE_DEFAULT_HOURS;
  return Math.max(WORKER_TIMELINE_MIN_HOURS, Math.min(WORKER_TIMELINE_MAX_HOURS, Math.floor(hours)));
}
