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

  return router;
}
