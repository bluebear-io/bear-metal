import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { DbClient } from "../db/client.js";
import { createRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");
const indexHtml = readFileSync(join(UI_DIST, "index.html"), "utf-8");

export function createApp(db: DbClient, maxIterations: number): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(db, maxIterations));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    res.type("html").send(indexHtml);
  });
  return app;
}
