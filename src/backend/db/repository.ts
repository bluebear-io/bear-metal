import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Ticket, Run, PullRequestRow, CiRun, EventRow, Worker } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const WORKER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;

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

export type StopReason = NonNullable<Run["stopReason"]>;

export interface ListTicketsFilter {
  /** Free text matched against identifier / title / description / branch name (case-insensitive). */
  search?: string;
  /** Limit to tickets currently in any of these bm_status values. */
  bmStatuses?: Ticket["bmStatus"][];
  /** Limit to tickets that have at least one run on any of these workers. */
  workerIds?: string[];
  /** Match tickets whose labelsJson array contains ALL of these labels. */
  labels?: string[];
  /** Limit to tickets that have at least one run with any of these stop_reason values. */
  stopReasons?: StopReason[];
  /** Substring of a run.error message (case-insensitive). */
  errorSignature?: string;
  /** ISO timestamps (inclusive). */
  createdAfter?: Date;
  createdBefore?: Date;
  updatedAfter?: Date;
  updatedBefore?: Date;
  page?: number;
  pageSize?: number;
}

export interface ListTicketsResult {
  tickets: TicketListItem[];
  total: number;
  page: number;
  pageSize: number;
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

function escapeLike(value: string): string {
  // Escape LIKE wildcards so user input is treated as a literal substring.
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildTicketWhere(filter: ListTicketsFilter | undefined): SQL | undefined {
  if (!filter) return undefined;
  const conditions: SQL[] = [];

  if (filter.search && filter.search.trim() !== "") {
    const needle = `%${escapeLike(filter.search.trim().toLowerCase())}%`;
    // SQLite's LIKE has no default escape character, so we must specify ESCAPE '\\' to
    // make the backslash escapes emitted by escapeLike() actually neutralise % and _.
    const searchCond = or(
      sql`lower(${schema.tickets.identifier}) like ${needle} escape '\\'`,
      sql`lower(${schema.tickets.title}) like ${needle} escape '\\'`,
      sql`lower(coalesce(${schema.tickets.description}, '')) like ${needle} escape '\\'`,
      sql`lower(${schema.tickets.branchName}) like ${needle} escape '\\'`,
    );
    if (searchCond) conditions.push(searchCond);
  }

  if (filter.bmStatuses && filter.bmStatuses.length > 0) {
    conditions.push(inArray(schema.tickets.bmStatus, filter.bmStatuses));
  }

  if (filter.labels && filter.labels.length > 0) {
    // labelsJson is a JSON array string; use json_each so we compare actual array
    // elements instead of substring-matching the raw JSON (which is vulnerable to
    // labels that embed quote/comma characters).
    for (const label of filter.labels) {
      conditions.push(
        sql`exists (select 1 from json_each(${schema.tickets.labelsJson}) where value = ${label})`,
      );
    }
  }

  if (filter.createdAfter) conditions.push(gte(schema.tickets.createdAt, filter.createdAfter));
  if (filter.createdBefore) conditions.push(lte(schema.tickets.createdAt, filter.createdBefore));
  if (filter.updatedAfter) conditions.push(gte(schema.tickets.updatedAt, filter.updatedAfter));
  if (filter.updatedBefore) conditions.push(lte(schema.tickets.updatedAt, filter.updatedBefore));

  // Run-derived filters: at least one run on the ticket must match.
  const runConditions: SQL[] = [];
  if (filter.workerIds && filter.workerIds.length > 0) {
    runConditions.push(inArray(schema.runs.workerId, filter.workerIds));
  }
  if (filter.stopReasons && filter.stopReasons.length > 0) {
    runConditions.push(inArray(schema.runs.stopReason, filter.stopReasons));
  }
  if (filter.errorSignature && filter.errorSignature.trim() !== "") {
    const needle = `%${escapeLike(filter.errorSignature.trim().toLowerCase())}%`;
    runConditions.push(sql`lower(coalesce(${schema.runs.error}, '')) like ${needle} escape '\\'`);
  }
  if (runConditions.length > 0) {
    conditions.push(
      sql`exists (select 1 from ${schema.runs} where ${schema.runs.ticketId} = ${schema.tickets.id} and ${and(...runConditions)})`,
    );
  }

  if (conditions.length === 0) return undefined;
  return and(...conditions);
}

/**
 * Historical-archive list query. Returns a paginated slice plus the total match count so the UI
 * can render a "X of Y" footer without a second round-trip.
 */
export function listTickets(db: Db, filter?: ListTicketsFilter): ListTicketsResult {
  const where = buildTicketWhere(filter);
  const page = Math.max(1, Math.floor(filter?.page ?? 1));
  const requestedPageSize = filter?.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requestedPageSize)));
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(schema.tickets)
    .where(where)
    .get();
  const total = Number(totalRow?.count ?? 0);

  const ticketRows = db
    .select()
    .from(schema.tickets)
    .where(where)
    .orderBy(desc(schema.tickets.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  const tickets = ticketRows.map((ticket) => {
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

  return { tickets, total, page, pageSize };
}

/** Distinct non-null stop reasons currently present in the runs table. */
export function listStopReasons(db: Db): StopReason[] {
  const rows = db
    .selectDistinct({ stopReason: schema.runs.stopReason })
    .from(schema.runs)
    .where(sql`${schema.runs.stopReason} is not null`)
    .all();
  return rows
    .map((r) => r.stopReason)
    .filter((r): r is StopReason => r !== null)
    .sort();
}

/** Distinct labels across all tickets, derived from labelsJson arrays. */
export function listTicketLabels(db: Db): string[] {
  const rows = db.select({ labelsJson: schema.tickets.labelsJson }).from(schema.tickets).all();
  const seen = new Set<string>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.labelsJson);
    } catch (err) {
      console.warn(`listTicketLabels: failed to parse labelsJson ${JSON.stringify(row.labelsJson)}`, err);
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const label of parsed) {
      if (typeof label === "string" && label !== "") seen.add(label);
    }
  }
  return [...seen].sort();
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
