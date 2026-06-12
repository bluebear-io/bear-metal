import { Router } from "express";
import * as schema from "../db/schema.js";
import type { Repository } from "../db/repository.js";

const BM_STATUSES = schema.tickets.bmStatus.enumValues;
type BmStatus = (typeof BM_STATUSES)[number];

function isBmStatus(v: unknown): v is BmStatus {
  return typeof v === "string" && (BM_STATUSES as readonly string[]).includes(v);
}

export function createRouter(repo: Repository): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/tickets", async (req, res, next) => {
    try {
      const status = req.query.status;
      if (status !== undefined && !isBmStatus(status)) {
        res.status(400).json({ error: `invalid status filter: ${String(status)}` });
        return;
      }
      const tickets = await repo.listTickets(status !== undefined ? { bmStatus: status } : undefined);
      res.json({ tickets });
    } catch (err) {
      next(err);
    }
  });

  router.get("/tickets/:id", async (req, res, next) => {
    try {
      const detail = await repo.getTicketDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "ticket not found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  router.get("/workers", async (_req, res, next) => {
    try {
      res.json({ workers: await repo.listWorkers() });
    } catch (err) {
      next(err);
    }
  });

  router.get("/workers/timeline", async (req, res, next) => {
    try {
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - DEFAULT_TIMELINE_WINDOW_MS);
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
      // Cap the window so a stray query can't pull in unbounded transition history. The UI's
      // designed range is 24-72h; 7d is a generous ceiling that still bounds the response size.
      if (to.getTime() - from.getTime() > MAX_TIMELINE_WINDOW_MS) {
        res.status(400).json({ error: `timeline window must be ${MAX_TIMELINE_WINDOW_DAYS} days or less` });
        return;
      }
      const timeline = await repo.getWorkerTimeline({ from, to });
      res.json({
        window: { from: timeline.window.from.toISOString(), to: timeline.window.to.toISOString() },
        workers: timeline.workers.map((w) => ({
          workerId: w.workerId,
          workerName: w.workerName,
          spans: w.spans.map((s) => ({
            status: s.status,
            startedAt: s.startedAt.toISOString(),
            endedAt: s.endedAt ? s.endedAt.toISOString() : null,
          })),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/models/comparison", async (_req, res, next) => {
    try {
      res.json({ models: await repo.listModelComparison() });
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
      const summary = await repo.getPeriodSummary({ from, to });
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

const DEFAULT_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TIMELINE_WINDOW_DAYS = 7;
const MAX_TIMELINE_WINDOW_MS = MAX_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
