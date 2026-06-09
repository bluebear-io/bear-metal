import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";
import { createIngestRouter } from "./routes/ingest.js";

export interface AppOptions {
  /** Shared secret enabling the write (ingest) API. Empty/omitted → read-only server. */
  ingestToken?: string;
}

/** Build the Express app around an opened DB. A non-empty ingestToken mounts the write API. */
export function createApp(db: BetterSQLite3Database<typeof schema>, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(authStub);
  if (options.ingestToken) {
    app.use("/api", createIngestRouter(db, options.ingestToken));
  }
  app.use("/api", createRouter(db));
  return app;
}
