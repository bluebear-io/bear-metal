import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");

/** Build the Express app around an already-opened (read-only) DB. DB is injected so tests can pass a seeded in-memory DB. */
export function createApp(db: BetterSQLite3Database<typeof schema>): Express {
  const app = express();
  app.use(authStub);
  app.use("/api", createRouter(db));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    res.sendFile(join(UI_DIST, "index.html"));
  });
  return app;
}
