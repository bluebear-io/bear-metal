import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { DbClient } from "../db/client.js";
import { createRouter } from "./routes.js";
import type { LinearSource } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");
const INDEX_HTML_PATH = join(UI_DIST, "index.html");
const indexHtml = existsSync(INDEX_HTML_PATH) ? readFileSync(INDEX_HTML_PATH, "utf-8") : null;

export function createApp(db: DbClient, maxIterations: number, linear: LinearSource): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(db, maxIterations, linear));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    if (!indexHtml) { res.status(404).send("UI not built"); return; }
    res.type("html").send(indexHtml);
  });
  return app;
}
