import { Router } from "express";
import { MAX_TICKET_PAGE_SIZE, type DbClient, type ListTicketsOptions, type TicketListItem } from "../db/client.js";
import { MAX_ITERATIONS } from "./constants.js";

const BM_STATUSES = ["discovered", "dispatched", "in_progress", "pr_open", "ci_running", "ci_failed", "completed", "abandoned"] as const;
type BmStatus = (typeof BM_STATUSES)[number];
const STOP_REASONS = ["completed", "timeout", "crash", "error"] as const;
type StopReason = (typeof STOP_REASONS)[number];

function isBmStatus(v: unknown): v is BmStatus {
  return typeof v === "string" && (BM_STATUSES as readonly string[]).includes(v);
}

function isStopReason(v: unknown): v is StopReason {
  return typeof v === "string" && (STOP_REASONS as readonly string[]).includes(v);
}

// Express query values are string | string[] | ParsedQs | ParsedQs[] | undefined. We accept both
// the repeated-key form (`?key=a&key=b`) and the single-string comma shorthand (`?key=a,b`), but
// only split on commas for the single-string case — array elements are taken verbatim so a label
// that legitimately contains a comma (e.g. `"a,b"`) survives the round-trip when callers use the
// repeated-key form (which is what buildTicketsPath() does in the UI client).
function readList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
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

function serializeTicket(item: TicketListItem) {
  return {
    id: item.ticketId,
    identifier: item.ticketIdentifier,
    title: item.ticketTitle,
    description: item.ticketDescription,
    url: item.ticketUrl,
    branchName: item.ticketBranchName,
    linearStatusName: item.ticketLinearStatusName,
    linearStatusType: item.ticketLinearStatusType,
    labelsJson: item.ticketLabelsJson,
    bmStatus: item.bmStatus,
    attemptCount: item.attemptCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    latestRun: item.latestRun,
    latestWorkerName: item.latestWorkerName,
    latestPr: item.latestPr,
    latestCiStatus: item.latestCiStatus,
  };
}

export function createRouter(db: DbClient): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/config", (_req, res) => {
    res.json({ maxIterations: MAX_ITERATIONS });
  });

  router.get("/tickets/filters", async (_req, res, next) => {
    try {
      res.json(await db.listTicketFilterOptions());
    } catch (err) {
      next(err);
    }
  });

  router.get("/tickets", async (req, res, next) => {
    try {
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

      const result = await db.listTickets(opts);
      res.json({
        tickets: result.items.map(serializeTicket),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tickets/:id", async (req, res, next) => {
    try {
      const detail = await db.getTicketDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "ticket not found" });
        return;
      }
      res.json({ ...detail, ticket: serializeTicket(detail.ticket) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/workers", async (_req, res, next) => {
    try {
      res.json({ workers: await db.listWorkers() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/models/comparison", async (_req, res, next) => {
    try {
      res.json({ models: await db.listModelComparison() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/summary", async (req, res, next) => {
    try {
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const to = parseIsoOrDefault(req.query.to, now);
      const from = parseIsoOrDefault(req.query.from, defaultFrom);
      if (!from || !to) {
        res.status(400).json({ error: "from and to must be valid ISO timestamps" });
        return;
      }
      if (from.getTime() >= to.getTime()) {
        res.status(400).json({ error: "from must be before to" });
        return;
      }
      // The summary loads the relevant rows in full and computes both the current and prior
      // windows in JS — bound the requested window so an arbitrary range can't pull in the
      // entire dataset and starve the worker.
      if (to.getTime() - from.getTime() > MAX_SUMMARY_WINDOW_MS) {
        res.status(400).json({ error: `summary window must be ${MAX_SUMMARY_WINDOW_DAYS} days or less` });
        return;
      }
      const summary = await db.getPeriodSummary({ from, to });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function parseIsoOrDefault(raw: unknown, fallback: Date): Date | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MAX_SUMMARY_WINDOW_DAYS = 90;
const MAX_SUMMARY_WINDOW_MS = MAX_SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
