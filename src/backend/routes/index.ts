import { Router } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { listTickets, getTicketDetail, listWorkers } from "../db/repository.js";

const BM_STATUSES = ["discovered", "dispatched", "in_progress", "pr_open", "ci_running", "ci_failed", "completed", "abandoned"] as const;
type BmStatus = (typeof BM_STATUSES)[number];

export function createRouter(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/tickets", (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !BM_STATUSES.includes(status as BmStatus)) {
      res.status(400).json({ error: `invalid status filter: ${String(status)}` });
      return;
    }
    res.json({ tickets: listTickets(db, status ? { bmStatus: status as BmStatus } : undefined) });
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
