import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";
import { createIngestRouter } from "./routes/ingest.js";
import { DEFAULT_HOURS_PER_COMPLEXITY, type HoursPerComplexity } from "./config.js";

export interface AppOptions {
  /** Shared secret enabling the write (ingest) API. Empty/omitted → read-only server. */
  ingestToken?: string;
  /** Estimated human hours per complexity level; defaults to DEFAULT_HOURS_PER_COMPLEXITY. */
  hoursPerComplexity?: HoursPerComplexity;
}

/** Build the Express app around an opened DB. A non-empty ingestToken mounts the write API. */
export function createApp(db: BetterSQLite3Database<typeof schema>, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(authStub);
  const hoursPerComplexity = options.hoursPerComplexity ?? DEFAULT_HOURS_PER_COMPLEXITY;
  if (options.ingestToken) {
    app.use("/api", createIngestRouter(db, options.ingestToken, hoursPerComplexity));
  }
  app.use("/api", createRouter(db));
  return app;
}
