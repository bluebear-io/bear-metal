import express, { type Express } from "express";

import type { TaskQueue } from "./tasks.js";

export interface ServerDeps {
  tasks: TaskQueue;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();

  app.get("/health", (_req, res, next) => {
    void deps.tasks.countTracked()
      .then((activeTickets) => {
        res.json({
          status: "ok",
          uptime: process.uptime(),
          activeTickets,
        });
      })
      .catch(next);
  });

  return app;
}
