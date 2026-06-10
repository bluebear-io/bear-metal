import { Router } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  MAX_TICKET_PAGE_SIZE,
  listTickets,
  listTicketFilterOptions,
  getTicketDetail,
  listWorkers,
  listModelComparison,
  type ListTicketsOptions,
} from "../db/repository.js";

const BM_STATUSES = schema.tickets.bmStatus.enumValues;
type BmStatus = (typeof BM_STATUSES)[number];
const STOP_REASONS = schema.runs.stopReason.enumValues;
type StopReason = (typeof STOP_REASONS)[number];

function isBmStatus(v: unknown): v is BmStatus {
  return typeof v === "string" && (BM_STATUSES as readonly string[]).includes(v);
}

function isStopReason(v: unknown): v is StopReason {
  return typeof v === "string" && (STOP_REASONS as readonly string[]).includes(v);
}

// Express query values are string | string[] | ParsedQs | ParsedQs[] | undefined; we accept
// `?key=a&key=b` and `?key=a,b` uniformly.
function readList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => readList(v));
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalDate(value: unknown, name: string): Date | undefined {
  const s = readOptionalString(value);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ${name} (must be ISO-8601): ${s}`);
  }
  return d;
}

function readOptionalInt(value: unknown, name: string): number | undefined {
  const s = readOptionalString(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n)) {
    throw new Error(`invalid ${name} (must be an integer): ${s}`);
  }
  return n;
}

export function createRouter(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/tickets/filters", (_req, res) => {
    res.json(listTicketFilterOptions(db));
  });

  router.get("/tickets", (req, res) => {
    // Accept the legacy single `status` param alongside the new `statuses` list so existing
    // clients keep working while the dashboard moves to the multi-select.
    const legacyStatus = req.query.status;
    const statusList = readList(req.query.statuses);
    if (legacyStatus !== undefined) {
      if (Array.isArray(legacyStatus)) {
        res.status(400).json({ error: "status filter must be a single value; use statuses=a,b for multiple" });
        return;
      }
      statusList.push(String(legacyStatus));
    }
    const invalidStatus = statusList.find((s) => !isBmStatus(s));
    if (invalidStatus !== undefined) {
      res.status(400).json({ error: `invalid status filter: ${invalidStatus}` });
      return;
    }
    const bmStatuses = statusList.length > 0 ? (Array.from(new Set(statusList)) as BmStatus[]) : undefined;

    const stopReasonList = readList(req.query.stopReason).concat(readList(req.query.stopReasons));
    const invalidStop = stopReasonList.find((s) => !isStopReason(s));
    if (invalidStop !== undefined) {
      res.status(400).json({ error: `invalid stopReason filter: ${invalidStop}` });
      return;
    }
    const stopReasons = stopReasonList.length > 0 ? (Array.from(new Set(stopReasonList)) as StopReason[]) : undefined;

    const workerIdList = readList(req.query.workerId).concat(readList(req.query.workerIds));
    const workerIds = workerIdList.length > 0 ? Array.from(new Set(workerIdList)) : undefined;

    const labelList = readList(req.query.label).concat(readList(req.query.labels));
    const labels = labelList.length > 0 ? Array.from(new Set(labelList)) : undefined;

    let createdFrom: Date | undefined;
    let createdTo: Date | undefined;
    let page: number | undefined;
    let pageSize: number | undefined;
    try {
      createdFrom = readOptionalDate(req.query.createdFrom, "createdFrom");
      createdTo = readOptionalDate(req.query.createdTo, "createdTo");
      page = readOptionalInt(req.query.page, "page");
      pageSize = readOptionalInt(req.query.pageSize, "pageSize");
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (createdFrom && createdTo && createdFrom.getTime() > createdTo.getTime()) {
      res.status(400).json({ error: "createdFrom must be on or before createdTo" });
      return;
    }
    if (pageSize !== undefined && (pageSize < 1 || pageSize > MAX_TICKET_PAGE_SIZE)) {
      res.status(400).json({ error: `pageSize must be between 1 and ${MAX_TICKET_PAGE_SIZE}` });
      return;
    }
    if (page !== undefined && page < 1) {
      res.status(400).json({ error: "page must be >= 1" });
      return;
    }

    const opts: ListTicketsOptions = {
      q: readOptionalString(req.query.q),
      bmStatuses,
      workerIds,
      labels,
      stopReasons,
      createdFrom,
      createdTo,
      page,
      pageSize,
    };

    const result = listTickets(db, opts);
    res.json({
      tickets: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
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

  router.get("/models/comparison", (_req, res) => {
    res.json({ models: listModelComparison(db) });
  });

  return router;
}
