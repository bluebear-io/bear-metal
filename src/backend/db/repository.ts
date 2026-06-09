import { desc, eq, gte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Ticket, Run, PullRequestRow, CiRun, EventRow, Worker } from "./types.js";
import { modelPrice } from "../config.js";

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

export interface TicketCost {
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  completedAt: Date | null;
}

export interface CostSummary {
  periodStart: Date;
  periodEnd: Date;
  totalCostUsd: number;
  ticketCount: number;
  byTicket: TicketCost[];
}

export interface BudgetStatus {
  monthlyBudgetUsd: number | null;
  spentThisMonthUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
}

export type CostPeriod = "day" | "week" | "month";

function rowCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = modelPrice(modelId);
  return (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000;
}

export function listTicketCosts(db: Db): TicketCost[] {
  const rows = db.select().from(schema.tokenUsage).all();
  const byTicket = new Map<string, { input: number; output: number; cost: number }>();
  for (const r of rows) {
    const agg = byTicket.get(r.ticketId) ?? { input: 0, output: 0, cost: 0 };
    agg.input += r.inputTokens;
    agg.output += r.outputTokens;
    agg.cost += rowCostUsd(r.modelId, r.inputTokens, r.outputTokens);
    byTicket.set(r.ticketId, agg);
  }
  const result: TicketCost[] = [];
  for (const [ticketId, agg] of byTicket) {
    const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
    if (!ticket) continue;
    result.push({
      ticketId,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      inputTokens: agg.input,
      outputTokens: agg.output,
      costUsd: agg.cost,
      completedAt: ticket.completedAt,
    });
  }
  result.sort((a, b) => b.costUsd - a.costUsd);
  return result;
}

function periodBounds(period: CostPeriod, now: Date): { start: Date; end: Date } {
  const end = now;
  if (period === "day") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { start, end };
  }
  if (period === "week") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - 6);
    return { start, end };
  }
  // month
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return { start, end };
}

export function getCostSummary(db: Db, period: CostPeriod, now: Date = new Date()): CostSummary {
  const { start, end } = periodBounds(period, now);
  const rows = db.select().from(schema.tokenUsage).where(gte(schema.tokenUsage.createdAt, start)).all();
  const inWindow = rows.filter((r) => r.createdAt < end);
  const byTicket = new Map<string, { input: number; output: number; cost: number }>();
  for (const r of inWindow) {
    const agg = byTicket.get(r.ticketId) ?? { input: 0, output: 0, cost: 0 };
    agg.input += r.inputTokens;
    agg.output += r.outputTokens;
    agg.cost += rowCostUsd(r.modelId, r.inputTokens, r.outputTokens);
    byTicket.set(r.ticketId, agg);
  }
  const ticketRows: TicketCost[] = [];
  let totalCostUsd = 0;
  for (const [ticketId, agg] of byTicket) {
    const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
    if (!ticket) continue;
    ticketRows.push({
      ticketId,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      inputTokens: agg.input,
      outputTokens: agg.output,
      costUsd: agg.cost,
      completedAt: ticket.completedAt,
    });
    totalCostUsd += agg.cost;
  }
  ticketRows.sort((a, b) => b.costUsd - a.costUsd);
  return {
    periodStart: start,
    periodEnd: end,
    totalCostUsd,
    ticketCount: ticketRows.length,
    byTicket: ticketRows,
  };
}

export function getBudgetStatus(db: Db, monthlyBudgetUsd: number | null, now: Date = new Date()): BudgetStatus {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const rows = db.select().from(schema.tokenUsage)
    .where(gte(schema.tokenUsage.createdAt, start)).all();
  const inMonth = rows.filter((r) => r.createdAt < end);
  let spent = 0;
  for (const r of inMonth) {
    spent += rowCostUsd(r.modelId, r.inputTokens, r.outputTokens);
  }
  if (monthlyBudgetUsd === null) {
    return { monthlyBudgetUsd: null, spentThisMonthUsd: spent, remainingUsd: null, percentUsed: null };
  }
  const remaining = monthlyBudgetUsd - spent;
  const percent = monthlyBudgetUsd === 0 ? 0 : (spent / monthlyBudgetUsd) * 100;
  return { monthlyBudgetUsd, spentThisMonthUsd: spent, remainingUsd: remaining, percentUsed: percent };
}
