import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Ticket, Run, PullRequestRow, CiRun, EventRow, Worker } from "./types.js";

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

export interface TicketDetail {
  ticket: Ticket;
  runs: (Run & { worker: Worker | null })[];
  pullRequests: PullRequestRow[];
  ciRuns: CiRun[];
  events: EventRow[];
}

export interface OutcomeBreakdown {
  total: number;
  completed: number;
  abandoned: number;
  inFlight: number;
  successRate: number;
  abandonmentRate: number;
}

export interface AttemptsBucket {
  attempts: number;
  count: number;
}

export interface MttrStats {
  sampleSize: number;
  meanMs: number | null;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface ThroughputPoint {
  date: string; // YYYY-MM-DD (UTC)
  created: number;
  completed: number;
}

export interface AnalyticsSummary {
  generatedAt: Date;
  outcomes: OutcomeBreakdown;
  attemptsDistribution: AttemptsBucket[];
  mttr: MttrStats;
  throughput: ThroughputPoint[];
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
  const runs = runRows.map((r) => ({ ...r, worker: r.workerId ? workersById.get(r.workerId) ?? null : null }));

  const pullRequests = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.ticketId, id)).orderBy(desc(schema.pullRequests.updatedAt)).all();
  const ciRuns = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, id)).orderBy(schema.ciRuns.createdAt).all();
  const events = db.select().from(schema.events).where(eq(schema.events.ticketId, id)).orderBy(schema.events.createdAt).all();

  return { ticket, runs, pullRequests, ciRuns, events };
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

const IN_FLIGHT_STATUSES: ReadonlySet<Ticket["bmStatus"]> = new Set([
  "discovered",
  "dispatched",
  "in_progress",
  "pr_open",
  "ci_running",
  "ci_failed",
]);

const toUtcDateKey = (d: Date): string => d.toISOString().slice(0, 10);

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    throw new Error("percentile() requires a non-empty sorted array");
  }
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  // Linear interpolation between closest ranks.
  const rank = (sortedAsc.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function getAnalytics(db: Db, options: { now?: Date } = {}): AnalyticsSummary {
  const now = options.now ?? new Date();
  const tickets = db.select().from(schema.tickets).all();

  let completed = 0;
  let abandoned = 0;
  let inFlight = 0;
  for (const t of tickets) {
    if (t.bmStatus === "completed") completed++;
    else if (t.bmStatus === "abandoned") abandoned++;
    else if (IN_FLIGHT_STATUSES.has(t.bmStatus)) inFlight++;
  }
  const decided = completed + abandoned;
  const outcomes: OutcomeBreakdown = {
    total: tickets.length,
    completed,
    abandoned,
    inFlight,
    successRate: decided === 0 ? 0 : completed / decided,
    abandonmentRate: decided === 0 ? 0 : abandoned / decided,
  };

  const attemptCounts = new Map<number, number>();
  for (const t of tickets) {
    if (t.bmStatus !== "completed" && t.bmStatus !== "abandoned") continue;
    const n = Math.max(1, t.attemptCount);
    attemptCounts.set(n, (attemptCounts.get(n) ?? 0) + 1);
  }
  const attemptsDistribution: AttemptsBucket[] = [...attemptCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([attempts, count]) => ({ attempts, count }));

  const resolutionMs: number[] = [];
  for (const t of tickets) {
    if (t.bmStatus !== "completed" || !t.completedAt) continue;
    const ms = t.completedAt.getTime() - t.createdAt.getTime();
    if (ms >= 0) resolutionMs.push(ms);
  }
  resolutionMs.sort((a, b) => a - b);
  const mttr: MttrStats = resolutionMs.length === 0
    ? { sampleSize: 0, meanMs: null, medianMs: null, p90Ms: null }
    : {
        sampleSize: resolutionMs.length,
        meanMs: resolutionMs.reduce((s, v) => s + v, 0) / resolutionMs.length,
        medianMs: percentile(resolutionMs, 0.5),
        p90Ms: percentile(resolutionMs, 0.9),
      };

  const throughput: ThroughputPoint[] = [];
  if (tickets.length > 0) {
    const createdBucket = new Map<string, number>();
    const completedBucket = new Map<string, number>();
    let minMs = Number.POSITIVE_INFINITY;
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const t of tickets) {
      const cKey = toUtcDateKey(t.createdAt);
      createdBucket.set(cKey, (createdBucket.get(cKey) ?? 0) + 1);
      minMs = Math.min(minMs, t.createdAt.getTime());
      maxMs = Math.max(maxMs, t.createdAt.getTime());
      if (t.completedAt) {
        const dKey = toUtcDateKey(t.completedAt);
        completedBucket.set(dKey, (completedBucket.get(dKey) ?? 0) + 1);
        maxMs = Math.max(maxMs, t.completedAt.getTime());
      }
    }
    maxMs = Math.max(maxMs, now.getTime());

    const startD = new Date(minMs);
    const start = Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), startD.getUTCDate());
    const endD = new Date(maxMs);
    const end = Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth(), endD.getUTCDate());
    const dayMs = 24 * 60 * 60 * 1000;
    for (let cursor = start; cursor <= end; cursor += dayMs) {
      const key = toUtcDateKey(new Date(cursor));
      throughput.push({
        date: key,
        created: createdBucket.get(key) ?? 0,
        completed: completedBucket.get(key) ?? 0,
      });
    }
  }

  return { generatedAt: now, outcomes, attemptsDistribution, mttr, throughput };
}
