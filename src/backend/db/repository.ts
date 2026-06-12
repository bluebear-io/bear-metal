import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type {
  Ticket, Run, PullRequestRow, CiRun, CiCheck, ReviewThreadRow, RunToolCallRow, EventRow, Worker,
  WorkerStateTransitionRow,
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

/* ------------------------------------------------------------------------- */
/*                         Period summary types                              */
/* ------------------------------------------------------------------------- */

export interface ThroughputBlock {
  completed: number;
  abandoned: number;
  discovered: number;
}

export interface HealthBlock {
  /** completed / (completed + abandoned), 0..1. Null when neither happened in the window. */
  successRate: number | null;
  /** Mean `attemptCount` over tickets whose final state landed in the window. Null when no such ticket. */
  avgAttempts: number | null;
  /** Share of those tickets with attemptCount > 1. */
  multiAttemptRate: number | null;
  /** Among ci_runs that completed in the window, share with status='passed'. Null when no CI completed. */
  ciPassRate: number | null;
}

export interface ModelCostRow {
  provider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
}

export interface CostBlock {
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  byModel: ModelCostRow[];
}

export interface TimeBlock {
  /** Mean wall-clock from ticket.createdAt → ticket.completedAt for tickets completed in window. */
  avgWallClockSeconds: number | null;
  /** Sum of runs[].endedAt - startedAt across runs that ended in the window. */
  totalAgentSeconds: number;
  /** completedCount * DEV_HOURS_PER_TICKET. */
  devHoursSaved: number;
}

export interface CheckFailureRow {
  name: string;
  count: number;
  latestDetailsUrl: string | null;
}

export interface TicketRef {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface RepoPassRow {
  repo: string;
  totalRuns: number;
  passedRuns: number;
  passRate: number;
}

export interface FailureBlock {
  topCiCheckNames: CheckFailureRow[];
  ticketsAtMaxAttempts: TicketRef[];
  worstReposByCi: RepoPassRow[];
}

export interface ShippedTicket extends TicketRef {
  labels: string[];
  prUrl: string;
  prNumber: number;
  completedAt: string | null;
}

export interface ShippedRepoBucket {
  repo: string;
  count: number;
  tickets: ShippedTicket[];
}

export interface ShippedBlock {
  byRepo: ShippedRepoBucket[];
}

export interface PeriodSummary {
  window: { from: string; to: string };
  prior: { from: string; to: string };
  throughput: ThroughputBlock & { prior: ThroughputBlock };
  health: HealthBlock & { prior: HealthBlock };
  cost: CostBlock & { prior: CostBlock };
  time: TimeBlock & { prior: TimeBlock };
  failures: FailureBlock;
  shipped: ShippedBlock;
}

export interface PeriodSummaryOptions {
  from: Date;
  to: Date;
}

/* ------------------------------------------------------------------------- */
/*                         Worker timeline types                             */
/* ------------------------------------------------------------------------- */

export interface WorkerTimelineSpan {
  status: Worker["status"];
  /** Span start, clamped to the requested window's `from` when the span began earlier. */
  startedAt: Date;
  /** Span end. Null for the currently-open span (interpreted by the UI as "now"). */
  endedAt: Date | null;
}

export interface WorkerTimelineRow {
  workerId: string;
  workerName: string;
  spans: WorkerTimelineSpan[];
}

export interface WorkerTimelineOptions {
  from: Date;
  to: Date;
}

export interface WorkerTimeline {
  window: { from: Date; to: Date };
  workers: WorkerTimelineRow[];
}

/** Dialect-agnostic read interface backing the dashboard's GET routes. */
export interface Repository {
  listTickets(filter?: { bmStatus?: Ticket["bmStatus"] }): Promise<TicketListItem[]>;
  getTicketDetail(id: string): Promise<TicketDetail | null>;
  listWorkers(options?: ListWorkerOptions): Promise<WorkerListItem[]>;
  /** Aggregate efficacy stats per (provider, model_name). Skips runs with no recorded model. */
  listModelComparison(): Promise<ModelComparisonRow[]>;
  /** Six-cluster summary for the productivity dashboard. */
  getPeriodSummary(options: PeriodSummaryOptions): Promise<PeriodSummary>;
  /** Worker status spans overlapping [from, to) for the worker utilization Gantt (DEN-2335). */
  getWorkerTimeline(options: WorkerTimelineOptions): Promise<WorkerTimeline>;
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

    async getPeriodSummary({ from, to }) {
      return computePeriodSummary(db, t, from, to);
    },

    async getWorkerTimeline({ from, to }) {
      const workers: Worker[] = await db.select().from(t.workers).orderBy(t.workers.name);
      // A span overlaps [from, to) iff (endedAt IS NULL OR endedAt > from) AND startedAt < to.
      const rows: WorkerStateTransitionRow[] = await db.select().from(t.workerStateTransitions)
        .where(and(
          lt(t.workerStateTransitions.startedAt, to),
          or(isNull(t.workerStateTransitions.endedAt), gte(t.workerStateTransitions.endedAt, from)),
        ))
        .orderBy(t.workerStateTransitions.workerId, t.workerStateTransitions.startedAt);
      const spansByWorker = new Map<string, WorkerTimelineSpan[]>();
      for (const row of rows) {
        // Clamp span start to the window edge so the UI can render directly without re-clipping.
        const startedAt = row.startedAt < from ? from : row.startedAt;
        const list = spansByWorker.get(row.workerId) ?? [];
        list.push({ status: row.status, startedAt, endedAt: row.endedAt });
        spansByWorker.set(row.workerId, list);
      }
      return {
        window: { from, to },
        workers: workers.map((w) => ({
          workerId: w.id,
          workerName: w.name,
          spans: spansByWorker.get(w.id) ?? [],
        })),
      };
    },
  };
}

/* ------------------------------------------------------------------------- */
/*                       Period summary implementation                       */
/* ------------------------------------------------------------------------- */

/**
 * v1 dev-hours-saved heuristic — one constant for every completed ticket. DEN-2320 will replace
 * this with a complexity-based lookup; until then a flat 4h/ticket gives the UI a meaningful number.
 */
const DEV_HOURS_PER_TICKET = 4;

/** Repos with fewer than this many CI runs in-window are hidden from the "worst repos" board. */
const WORST_REPO_MIN_RUNS = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computePeriodSummary(db: any, t: any, from: Date, to: Date): Promise<PeriodSummary> {
  const durationMs = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - durationMs);
  const priorTo = from;
  // Outer fetch covers [priorFrom, to). Per-block computation re-filters in JS.
  const outerFrom = priorFrom;
  const outerTo = to;

  const tickets: Ticket[] = await db.select().from(t.tickets);
  const runs: Run[] = await db.select().from(t.runs);
  const ciRuns: CiRun[] = await db.select().from(t.ciRuns);
  const ciChecks: CiCheck[] = await db.select().from(t.ciChecks);
  const prs: PullRequestRow[] = await db.select().from(t.pullRequests);

  const inOuterCi = ciRuns.filter((r) => r.completedAt && r.completedAt >= outerFrom && r.completedAt < outerTo);
  const inOuterChecks = ciChecks.filter((c) => c.createdAt >= outerFrom && c.createdAt < outerTo);
  const inOuterRuns = runs.filter((r) => r.endedAt && r.endedAt >= outerFrom && r.endedAt < outerTo);

  // Same-window blocks computed via shared helpers; failures + shipped only for the current window.
  const throughput = computeThroughput(tickets, from, to);
  const throughputPrior = computeThroughput(tickets, priorFrom, priorTo);
  const health = computeHealth(tickets, inOuterCi, from, to);
  const healthPrior = computeHealth(tickets, inOuterCi, priorFrom, priorTo);
  const cost = computeCost(inOuterRuns, from, to);
  const costPrior = computeCost(inOuterRuns, priorFrom, priorTo);
  const time = computeTime(tickets, inOuterRuns, from, to);
  const timePrior = computeTime(tickets, inOuterRuns, priorFrom, priorTo);

  const failures = computeFailures(tickets, inOuterChecks, inOuterCi, prs, from, to);
  const shipped = computeShipped(tickets, prs, from, to);

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    prior: { from: priorFrom.toISOString(), to: priorTo.toISOString() },
    throughput: { ...throughput, prior: throughputPrior },
    health: { ...health, prior: healthPrior },
    cost: { ...cost, prior: costPrior },
    time: { ...time, prior: timePrior },
    failures,
    shipped,
  };
}

function inRange(date: Date | null, from: Date, to: Date): boolean {
  return date !== null && date >= from && date < to;
}

function computeThroughput(tickets: Ticket[], from: Date, to: Date): ThroughputBlock {
  // "Throughput" = work that landed a terminal state during the window. Tickets that were merely
  // in-flight during the window aren't counted — in-progress is a state snapshot, not an
  // accomplishment, so it doesn't belong on a per-period metric.
  let completed = 0;
  let abandoned = 0;
  let discovered = 0;
  for (const ticket of tickets) {
    if (inRange(ticket.createdAt, from, to)) discovered += 1;
    if (ticket.bmStatus === "completed" && inRange(ticket.completedAt, from, to)) completed += 1;
    else if (ticket.bmStatus === "abandoned" && inRange(ticket.updatedAt, from, to)) abandoned += 1;
  }
  return { completed, abandoned, discovered };
}

function computeHealth(tickets: Ticket[], ciRunsInOuter: CiRun[], from: Date, to: Date): HealthBlock {
  let completed = 0;
  let abandoned = 0;
  let attemptsSum = 0;
  let multiAttempt = 0;
  for (const ticket of tickets) {
    const isCompleted = ticket.bmStatus === "completed" && inRange(ticket.completedAt, from, to);
    const isAbandoned = ticket.bmStatus === "abandoned" && inRange(ticket.updatedAt, from, to);
    if (!isCompleted && !isAbandoned) continue;
    if (isCompleted) completed += 1;
    else abandoned += 1;
    attemptsSum += ticket.attemptCount;
    if (ticket.attemptCount > 1) multiAttempt += 1;
  }
  const ticketSettled = completed + abandoned;
  const ciWindow = ciRunsInOuter.filter((r) => r.completedAt && inRange(r.completedAt, from, to));
  const ciPassed = ciWindow.filter((r) => r.status === "passed").length;
  const ciCompleted = ciWindow.filter((r) => r.status === "passed" || r.status === "failed").length;
  return {
    successRate: ticketSettled > 0 ? completed / ticketSettled : null,
    avgAttempts: ticketSettled > 0 ? attemptsSum / ticketSettled : null,
    multiAttemptRate: ticketSettled > 0 ? multiAttempt / ticketSettled : null,
    ciPassRate: ciCompleted > 0 ? ciPassed / ciCompleted : null,
  };
}

function computeCost(runsInOuter: Run[], from: Date, to: Date): CostBlock {
  const inWindow = runsInOuter.filter((r) => r.endedAt && inRange(r.endedAt, from, to));
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedUsd = 0;
  const buckets = new Map<string, { provider: string; modelName: string; promptTokens: number; completionTokens: number; estimatedUsd: number }>();
  for (const r of inWindow) {
    const p = r.promptTokens ?? 0;
    const c = r.completionTokens ?? 0;
    promptTokens += p;
    completionTokens += c;
    const cost = estimateCostUsd(r.provider, r.modelName, r.promptTokens, r.completionTokens);
    if (cost !== null) estimatedUsd += cost;
    if (r.provider && r.modelName) {
      const key = `${r.provider}::${r.modelName}`;
      const b = buckets.get(key) ?? { provider: r.provider, modelName: r.modelName, promptTokens: 0, completionTokens: 0, estimatedUsd: 0 };
      b.promptTokens += p;
      b.completionTokens += c;
      if (cost !== null) b.estimatedUsd += cost;
      buckets.set(key, b);
    }
  }
  const byModel = [...buckets.values()].sort((a, b) => b.estimatedUsd - a.estimatedUsd);
  return { promptTokens, completionTokens, estimatedUsd, byModel };
}

function computeTime(tickets: Ticket[], runsInOuter: Run[], from: Date, to: Date): TimeBlock {
  const wallClocks: number[] = [];
  let completedCount = 0;
  for (const ticket of tickets) {
    if (ticket.bmStatus !== "completed") continue;
    if (!inRange(ticket.completedAt, from, to)) continue;
    completedCount += 1;
    if (ticket.completedAt) {
      const seconds = Math.max(0, (ticket.completedAt.getTime() - ticket.createdAt.getTime()) / 1000);
      wallClocks.push(seconds);
    }
  }
  const avgWallClockSeconds = wallClocks.length > 0
    ? wallClocks.reduce((s, n) => s + n, 0) / wallClocks.length
    : null;
  let totalAgentSeconds = 0;
  for (const r of runsInOuter) {
    if (!r.startedAt || !r.endedAt) continue;
    if (!inRange(r.endedAt, from, to)) continue;
    totalAgentSeconds += Math.max(0, (r.endedAt.getTime() - r.startedAt.getTime()) / 1000);
  }
  return {
    avgWallClockSeconds,
    totalAgentSeconds,
    devHoursSaved: completedCount * DEV_HOURS_PER_TICKET,
  };
}

/** Extract `owner/repo` from a github.com PR URL; null on unparseable input. */
function repoFromPrUrl(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function computeFailures(tickets: Ticket[], checksInOuter: CiCheck[], ciRunsInOuter: CiRun[], prs: PullRequestRow[], from: Date, to: Date): FailureBlock {
  const inWindowChecks = checksInOuter.filter((c) => inRange(c.createdAt, from, to));

  type CheckBucket = { count: number; latestAt: Date; latestDetailsUrl: string | null };
  const checkBuckets = new Map<string, CheckBucket>();
  for (const c of inWindowChecks) {
    const b = checkBuckets.get(c.name) ?? { count: 0, latestAt: new Date(0), latestDetailsUrl: null };
    b.count += 1;
    if (c.createdAt > b.latestAt) {
      b.latestAt = c.createdAt;
      b.latestDetailsUrl = c.detailsUrl;
    }
    checkBuckets.set(c.name, b);
  }
  const topCiCheckNames: CheckFailureRow[] = [...checkBuckets.entries()]
    .map(([name, b]) => ({ name, count: b.count, latestDetailsUrl: b.latestDetailsUrl }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const ticketsAtMaxAttempts: TicketRef[] = tickets
    .filter((ticket) => ticket.bmStatus === "abandoned" && ticket.attemptCount >= ticket.maxAttempts && inRange(ticket.updatedAt, from, to))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 20)
    .map((ticket) => ({ id: ticket.id, identifier: ticket.identifier, title: ticket.title, url: ticket.url }));

  const prById = new Map<string, PullRequestRow>(prs.map((pr) => [pr.id, pr]));
  type RepoBucket = { totalRuns: number; passedRuns: number };
  const repoBuckets = new Map<string, RepoBucket>();
  for (const r of ciRunsInOuter) {
    if (!inRange(r.completedAt, from, to)) continue;
    if (r.status !== "passed" && r.status !== "failed") continue;
    const pr = r.prId ? prById.get(r.prId) : null;
    if (!pr) continue;
    const repo = repoFromPrUrl(pr.url);
    if (!repo) continue;
    const b = repoBuckets.get(repo) ?? { totalRuns: 0, passedRuns: 0 };
    b.totalRuns += 1;
    if (r.status === "passed") b.passedRuns += 1;
    repoBuckets.set(repo, b);
  }
  const worstReposByCi: RepoPassRow[] = [...repoBuckets.entries()]
    .filter(([, b]) => b.totalRuns >= WORST_REPO_MIN_RUNS)
    .map(([repo, b]) => ({ repo, totalRuns: b.totalRuns, passedRuns: b.passedRuns, passRate: b.passedRuns / b.totalRuns }))
    .sort((a, b) => a.passRate - b.passRate)
    .slice(0, 10);

  return { topCiCheckNames, ticketsAtMaxAttempts, worstReposByCi };
}

function computeShipped(tickets: Ticket[], prs: PullRequestRow[], from: Date, to: Date): ShippedBlock {
  const completed = tickets.filter((ticket) => ticket.bmStatus === "completed" && inRange(ticket.completedAt, from, to));
  const mergedPrByTicket = new Map<string, PullRequestRow>();
  for (const pr of prs) {
    if (!pr.merged) continue;
    const existing = mergedPrByTicket.get(pr.ticketId);
    if (!existing || pr.updatedAt > existing.updatedAt) mergedPrByTicket.set(pr.ticketId, pr);
  }
  type RepoBucket = { tickets: ShippedTicket[] };
  const buckets = new Map<string, RepoBucket>();
  for (const ticket of completed) {
    const pr = mergedPrByTicket.get(ticket.id);
    if (!pr) continue;
    const repo = repoFromPrUrl(pr.url) ?? "unknown";
    let labels: string[] = [];
    try {
      const parsed: unknown = JSON.parse(ticket.labelsJson);
      if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === "string");
    } catch (err) {
      // Malformed labelsJson — render the row without labels rather than dropping it, but log
      // so the corruption is visible in ops dashboards instead of vanishing into a UI gap.
      console.warn(`[summary] skipping malformed labelsJson for ticket ${ticket.id}:`, (err as Error).message);
    }
    const entry: ShippedTicket = {
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      url: ticket.url,
      labels,
      prUrl: pr.url,
      prNumber: pr.number,
      completedAt: ticket.completedAt?.toISOString() ?? null,
    };
    const b = buckets.get(repo) ?? { tickets: [] };
    b.tickets.push(entry);
    buckets.set(repo, b);
  }
  const byRepo: ShippedRepoBucket[] = [...buckets.entries()]
    .map(([repo, b]) => ({
      repo,
      count: b.tickets.length,
      tickets: b.tickets.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")),
    }))
    .sort((a, b) => b.count - a.count);
  return { byRepo };
}
