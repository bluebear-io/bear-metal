import { Router } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { listTickets, getTicketDetail, listWorkers, listModelComparison, listWorkerTimeline } from "../db/repository.js";

const DEFAULT_TIMELINE_HOURS = 24;
const MAX_TIMELINE_HOURS = 72;

const BM_STATUSES = schema.tickets.bmStatus.enumValues;
type BmStatus = (typeof BM_STATUSES)[number];

function isBmStatus(v: unknown): v is BmStatus {
  return typeof v === "string" && (BM_STATUSES as readonly string[]).includes(v);
}

export function createRouter(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/tickets", (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !isBmStatus(status)) {
      res.status(400).json({ error: `invalid status filter: ${String(status)}` });
      return;
    }
    res.json({ tickets: listTickets(db, status !== undefined ? { bmStatus: status } : undefined) });
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

  router.get("/workers/timeline", (req, res) => {
    // Reject (rather than silently clamp) out-of-range values so the UI can't accidentally
    // request a wider window than the dashboard is designed to render.
    const raw = req.query.hours;
    let hours = DEFAULT_TIMELINE_HOURS;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_TIMELINE_HOURS) {
        res.status(400).json({ error: `hours must be a number in (0, ${MAX_TIMELINE_HOURS}]` });
        return;
      }
      hours = parsed;
    }
    const untilMs = Date.now();
    const sinceMs = untilMs - hours * 60 * 60 * 1000;
    res.json(listWorkerTimeline(db, { sinceMs, untilMs }));
  });

  router.get("/models/comparison", (_req, res) => {
    res.json({ models: listModelComparison(db) });
  });

  return router;
}
