import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { DbClient } from "../db/client.js";
import { createRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");

export function createApp(db: DbClient): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", createRouter(db));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    res.sendFile(join(UI_DIST, "index.html"));
  });
  return app;
}
