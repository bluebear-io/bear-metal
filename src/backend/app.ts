import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";
import { createIngestRouter } from "./routes/ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");

export interface AppOptions {
  /** Shared secret enabling the write (ingest) API. Empty/omitted → read-only server. */
  ingestToken?: string;
}

// DB is injected so tests can pass a seeded in-memory DB. A non-empty ingestToken mounts the write API.
export function createApp(db: BetterSQLite3Database<typeof schema>, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(authStub);
  if (options.ingestToken) {
    app.use("/api", createIngestRouter(db, options.ingestToken));
  }
  app.use("/api", createRouter(db));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    res.sendFile(join(UI_DIST, "index.html"));
  });
  return app;
}
