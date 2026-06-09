import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";

/** Build the Express app around an already-opened (read-only) DB. DB is injected so tests can pass a seeded in-memory DB. */
export function createApp(db: BetterSQLite3Database<typeof schema>): Express {
  const app = express();
  app.use(authStub);
  app.use("/api", createRouter(db));
  return app;
}
