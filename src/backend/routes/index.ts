import { Router } from "express";
import type { Request } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getTicketDetail,
  listStopReasons,
  listTicketLabels,
  listTickets,
  listWorkers,
  type ListTicketsFilter,
  type StopReason,
} from "../db/repository.js";

const BM_STATUSES = schema.tickets.bmStatus.enumValues;
type BmStatus = (typeof BM_STATUSES)[number];
const STOP_REASONS = schema.runs.stopReason.enumValues;

function isBmStatus(v: string): v is BmStatus {
  return (BM_STATUSES as readonly string[]).includes(v);
}

function isStopReason(v: string): v is StopReason {
  return (STOP_REASONS as readonly string[]).includes(v);
}

class QueryParseError extends Error {}

/** Pull a query param as an array of trimmed non-empty strings. Accepts `?k=a&k=b` and `?k=a,b`. */
function asStringArray(value: Request["query"][string]): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new QueryParseError("array filter values must be strings");
    }
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") out.push(trimmed);
    }
  }
  return out;
}

function asString(value: Request["query"][string]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new QueryParseError("expected a string query parameter");
  }
  return value;
}

function asInt(value: Request["query"][string], name: string): number | undefined {
  const raw = asString(value);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new QueryParseError(`invalid integer for ${name}: ${raw}`);
  }
  return n;
}

function asDate(value: Request["query"][string], name: string): Date | undefined {
  const raw = asString(value);
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new QueryParseError(`invalid date for ${name}: ${raw}`);
  }
  return d;
}

function parseTicketFilter(req: Request): ListTicketsFilter {
  const filter: ListTicketsFilter = {};

  const search = asString(req.query.search);
  if (search !== undefined) filter.search = search;

  // Status: accept legacy single ?status= or new ?bmStatus= (array). Both are validated.
  const statuses = [...asStringArray(req.query.bmStatus), ...asStringArray(req.query.status)];
  if (statuses.length > 0) {
    for (const s of statuses) {
      if (!isBmStatus(s)) throw new QueryParseError(`invalid status filter: ${s}`);
    }
    filter.bmStatuses = statuses as BmStatus[];
  }

  const workerIds = asStringArray(req.query.workerId);
  if (workerIds.length > 0) filter.workerIds = workerIds;

  const labels = asStringArray(req.query.label);
  if (labels.length > 0) filter.labels = labels;

  const stopReasons = asStringArray(req.query.stopReason);
  if (stopReasons.length > 0) {
    for (const r of stopReasons) {
      if (!isStopReason(r)) throw new QueryParseError(`invalid stopReason filter: ${r}`);
    }
    filter.stopReasons = stopReasons as StopReason[];
  }

  const errorSignature = asString(req.query.errorSignature);
  if (errorSignature !== undefined) filter.errorSignature = errorSignature;

  filter.createdAfter = asDate(req.query.createdAfter, "createdAfter");
  filter.createdBefore = asDate(req.query.createdBefore, "createdBefore");
  filter.updatedAfter = asDate(req.query.updatedAfter, "updatedAfter");
  filter.updatedBefore = asDate(req.query.updatedBefore, "updatedBefore");

  const page = asInt(req.query.page, "page");
  if (page !== undefined) {
    if (page < 1) throw new QueryParseError(`page must be >= 1`);
    filter.page = page;
  }
  const pageSize = asInt(req.query.pageSize, "pageSize");
  if (pageSize !== undefined) {
    if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new QueryParseError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    filter.pageSize = pageSize;
  }

  return filter;
}

export function createRouter(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/tickets", (req, res) => {
    let filter: ListTicketsFilter;
    try {
      filter = parseTicketFilter(req);
    } catch (err) {
      if (err instanceof QueryParseError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    const result = listTickets(db, filter);
    res.json({
      tickets: result.tickets,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  router.get("/tickets/filters", (_req, res) => {
    res.json({
      bmStatuses: BM_STATUSES,
      stopReasons: listStopReasons(db),
      labels: listTicketLabels(db),
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });
  });

  router.get("/tickets/:id", (req, res) => {
    const detail = getTicketDetail(db, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "ticket not found" });
      return;
    }
    res.json(detail);
  });

  router.get("/workers", (_req, res) => {
    res.json({ workers: listWorkers(db) });
  });

  return router;
}
