import { Router } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import {
  listTickets, getTicketDetail, listWorkers,
  listTicketCosts, getCostSummary, getBudgetStatus,
  type CostPeriod,
} from "../db/repository.js";

const BM_STATUSES = schema.tickets.bmStatus.enumValues;
type BmStatus = (typeof BM_STATUSES)[number];

function isBmStatus(v: unknown): v is BmStatus {
  return typeof v === "string" && (BM_STATUSES as readonly string[]).includes(v);
}

const COST_PERIODS: readonly CostPeriod[] = ["day", "week", "month"];
function isCostPeriod(v: unknown): v is CostPeriod {
  return typeof v === "string" && (COST_PERIODS as readonly string[]).includes(v);
}

export interface RouterDeps {
  monthlyBudgetUsd: number | null;
}

export function createRouter(db: BetterSQLite3Database<typeof schema>, deps: RouterDeps = { monthlyBudgetUsd: null }): Router {
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

  router.get("/costs/tickets", (_req, res) => {
    res.json({ tickets: listTicketCosts(db) });
  });

  router.get("/costs/summary", (req, res) => {
    const period = req.query.period;
    if (!isCostPeriod(period)) {
      res.status(400).json({ error: `period must be one of: ${COST_PERIODS.join(", ")}` });
      return;
    }
    res.json(getCostSummary(db, period));
  });

  router.get("/costs/budget", (_req, res) => {
    res.json(getBudgetStatus(db, deps.monthlyBudgetUsd));
  });

  return router;
}
