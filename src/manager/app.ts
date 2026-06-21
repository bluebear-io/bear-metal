import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { DbClient } from "../db/client.js";
import { createRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");
const INDEX_HTML_PATH = join(UI_DIST, "index.html");
const indexHtml = existsSync(INDEX_HTML_PATH) ? readFileSync(INDEX_HTML_PATH, "utf-8") : null;

/**
 * Express app with only `/api/health` mounted. Used to start the HTTP server
 * before slow startup tasks (worker environment builder, DB schema init) so
 * the container's healthcheck reports healthy while those run.
 */
export function createBootstrapApp(): Express {
  const app = express();
  app.use(express.json());
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  return app;
}

/**
 * Adds DB-backed API routes, static UI assets, and the SPA fallback to an
 * existing app produced by createBootstrapApp(). Must be called after the
 * worker environment builder and DB init complete.
 */
export function mountFullApi(app: Express, db: DbClient, maxIterations: number): void {
  app.use("/api", createRouter(db, maxIterations));
  app.use(express.static(UI_DIST));
  app.get("*", (_req, res) => {
    if (!indexHtml) { res.status(404).send("UI not built"); return; }
    res.type("html").send(indexHtml);
  });
}

export function createApp(db: DbClient, maxIterations: number): Express {
  const app = createBootstrapApp();
  mountFullApi(app, db, maxIterations);
  return app;
}
