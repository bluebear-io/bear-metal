import express, { type Express } from "express";

import type { TicketStore } from "./state.js";

export interface ServerDeps {
  store: TicketStore;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      activeTickets: deps.store.count(),
    });
  });

  return app;
}
