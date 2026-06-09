import { desc, eq, and, isNotNull } from "drizzle-orm";
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

export interface TicketTimeSaving {
  ticketId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  complexityScore: number | null;
  estimatedHumanHours: number | null;
  /** Actual wall-clock hours bear-metal spent (sum of run durations). */
  actualBmHours: number | null;
  /** estimatedHumanHours - actualBmHours, or null if either is missing. */
  savedHours: number | null;
  completedAt: Date | null;
}

export interface TimeSavedSummary {
  totalEstimatedHumanHours: number;
  totalActualBmHours: number;
  totalSavedHours: number;
  ticketCount: number;
  byTicket: TicketTimeSaving[];
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Build the time-saved summary across all completed tickets.
 *
 * actualBmHours sums (endedAt - startedAt) over the ticket's runs that have both
 * timestamps set; runs missing either are skipped. If no run has measurable duration
 * actualBmHours is null and savedHours is null — we never silently treat "no run data"
 * as zero hours saved, because that would inflate the aggregate.
 */
export function getTimeSavedSummary(db: Db): TimeSavedSummary {
  const completedTickets = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.bmStatus, "completed"))
    .orderBy(desc(schema.tickets.completedAt))
    .all();

  const byTicket: TicketTimeSaving[] = completedTickets.map((ticket) => {
    const runRows = db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, ticket.id), isNotNull(schema.runs.startedAt), isNotNull(schema.runs.endedAt)))
      .all();
    let totalMs = 0;
    let measured = 0;
    for (const r of runRows) {
      if (r.startedAt && r.endedAt) {
        totalMs += Math.max(0, r.endedAt.getTime() - r.startedAt.getTime());
        measured += 1;
      }
    }
    const actualBmHours = measured > 0 ? totalMs / MS_PER_HOUR : null;
    const estimated = ticket.estimatedHumanHours;
    const savedHours = estimated !== null && actualBmHours !== null ? estimated - actualBmHours : null;
    return {
      ticketId: ticket.id,
      ticketIdentifier: ticket.identifier,
      ticketTitle: ticket.title,
      complexityScore: ticket.complexityScore,
      estimatedHumanHours: estimated,
      actualBmHours,
      savedHours,
      completedAt: ticket.completedAt,
    };
  });

  const totalEstimatedHumanHours = byTicket.reduce((s, t) => s + (t.estimatedHumanHours ?? 0), 0);
  const totalActualBmHours = byTicket.reduce((s, t) => s + (t.actualBmHours ?? 0), 0);
  const totalSavedHours = byTicket.reduce((s, t) => s + (t.savedHours ?? 0), 0);

  byTicket.sort((a, b) => (b.savedHours ?? -Infinity) - (a.savedHours ?? -Infinity));

  return {
    totalEstimatedHumanHours,
    totalActualBmHours,
    totalSavedHours,
    ticketCount: byTicket.length,
    byTicket,
  };
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
