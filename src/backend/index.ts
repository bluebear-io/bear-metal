import "dotenv/config";

import Database from "better-sqlite3";
import { createLogger } from "../shared/index.js";
import { loadBackendConfig } from "./config.js";
import { openReadWriteDb } from "./db/client.js";
import { createApp } from "./app.js";

// Create all tables on first boot; safe to run every time (IF NOT EXISTS).
// Historical data is disposable — wipe the file on the instance to reset.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, url TEXT NOT NULL, branch_name TEXT NOT NULL,
    linear_status_name TEXT NOT NULL, linear_status_type TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]', bm_status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    current_run_id TEXT, last_heartbeat_at INTEGER,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    attempt_number INTEGER NOT NULL, worker_id TEXT REFERENCES workers(id),
    trigger TEXT NOT NULL, status TEXT NOT NULL, context_json TEXT,
    started_at INTEGER, ended_at INTEGER, stop_reason TEXT, error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pull_requests (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    number INTEGER NOT NULL, title TEXT NOT NULL, head_ref TEXT NOT NULL,
    state TEXT NOT NULL, draft INTEGER NOT NULL, merged INTEGER NOT NULL,
    url TEXT NOT NULL, last_run_id TEXT REFERENCES runs(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_runs (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    run_id TEXT NOT NULL REFERENCES runs(id), pr_id TEXT REFERENCES pull_requests(id),
    status TEXT NOT NULL, url TEXT, summary TEXT,
    created_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT REFERENCES tickets(id),
    run_id TEXT REFERENCES runs(id), worker_id TEXT REFERENCES workers(id),
    source TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
    payload_json TEXT, created_at INTEGER NOT NULL
  );
`;

function main(): void {
  const config = loadBackendConfig();
  const logger = createLogger({ level: config.logLevel, name: "bear-metal-backend" });
  const { databaseUrl, dialect, port } = config;
  if (dialect !== "sqlite") {
    // Postgres path wired up in DEN-2332/T4. Until that lands, only SQLite is bootable.
    throw new Error(`BEAR_METAL_DATABASE_URL dialect "${dialect}" not yet supported by this binary`);
  }
  const dbPath = databaseUrl.slice("sqlite:".length);
  if (!dbPath) throw new Error(`sqlite: URL must include a path: ${databaseUrl}`);
  // Create the file and tables out of band, then open it read-write for the sole writer.
  // openReadWriteDb fails fast on a missing file, so this init must run first.
  const init = new Database(dbPath);
  init.exec(SCHEMA_SQL);
  init.close();
  const { db, sqlite } = openReadWriteDb(dbPath);
  const app = createApp(db, { ingestToken: config.ingestToken });
  const server = app.listen(port, () => logger.info({ port, dbPath, dialect }, "bear-metal dashboard backend listening"));

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close(() => {
      sqlite.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
