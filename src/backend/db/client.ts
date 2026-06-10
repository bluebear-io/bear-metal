import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { detectDialect, type DatabaseDialect } from "../config.js";
import * as schemaSqlite from "./schema.js";
import * as schemaPg from "./schema-pg.js";

/**
 * Discriminated union returned by the factory. Callers narrow on `.dialect` when they need
 * dialect-specific behavior; most writer/repository code accesses `.db` and `.schema` directly
 * and relies on Drizzle's query builder being structurally compatible across the two dialects
 * (the schema-pg parity test enforces this).
 */
export type DbHandle =
  | {
      dialect: "sqlite";
      db: BetterSQLite3Database<typeof schemaSqlite>;
      schema: typeof schemaSqlite;
      close: () => Promise<void>;
    }
  | {
      dialect: "postgres";
      db: NodePgDatabase<typeof schemaPg>;
      schema: typeof schemaPg;
      close: () => Promise<void>;
    };

/** Raw `CREATE TABLE IF NOT EXISTS` script for SQLite — same shape that previously lived in index.ts. */
const SCHEMA_SQL_SQLITE = `
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

/**
 * Postgres mirror of the SQLite bootstrap. Timestamps use TIMESTAMPTZ (matches Drizzle's
 * `timestamp({withTimezone, mode:date})` in schema-pg.ts), booleans use BOOLEAN.
 */
const SCHEMA_SQL_PG = `
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, title TEXT NOT NULL,
    description TEXT, url TEXT NOT NULL, branch_name TEXT NOT NULL,
    linear_status_name TEXT NOT NULL, linear_status_type TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]', bm_status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    current_run_id TEXT, last_heartbeat_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    attempt_number INTEGER NOT NULL, worker_id TEXT REFERENCES workers(id),
    trigger TEXT NOT NULL, status TEXT NOT NULL, context_json TEXT,
    started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, stop_reason TEXT, error TEXT,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pull_requests (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    number INTEGER NOT NULL, title TEXT NOT NULL, head_ref TEXT NOT NULL,
    state TEXT NOT NULL, draft BOOLEAN NOT NULL, merged BOOLEAN NOT NULL,
    url TEXT NOT NULL, last_run_id TEXT REFERENCES runs(id),
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ci_runs (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id),
    run_id TEXT NOT NULL REFERENCES runs(id), pr_id TEXT REFERENCES pull_requests(id),
    status TEXT NOT NULL, url TEXT, summary TEXT,
    created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL, ticket_id TEXT REFERENCES tickets(id),
    run_id TEXT REFERENCES runs(id), worker_id TEXT REFERENCES workers(id),
    source TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
    payload_json TEXT, created_at TIMESTAMPTZ NOT NULL
  );
`;

function sqlitePathFromUrl(databaseUrl: string): string {
  const path = databaseUrl.slice("sqlite:".length);
  if (!path) throw new Error(`sqlite: URL must include a path: ${databaseUrl}`);
  return path;
}

/**
 * Open the dashboard DB read-write and ensure the schema is in place. The backend process is the
 * sole writer; the manager and worker push data through the ingest HTTP API and never open the
 * DB directly.
 *
 * Per repo policy: the dashboard's writes arrive best-effort and out of order (a child row can
 * land before its parent), so FK enforcement is disabled at the session/connection level.
 */
export async function openWritableDbFromUrl(databaseUrl: string): Promise<DbHandle> {
  const dialect = detectDialect(databaseUrl);
  if (dialect === "sqlite") {
    const path = sqlitePathFromUrl(databaseUrl);
    const sqlite = new Database(path);
    sqlite.exec(SCHEMA_SQL_SQLITE);
    sqlite.pragma("foreign_keys = OFF");
    const db = drizzleSqlite(sqlite, { schema: schemaSqlite });
    return {
      dialect: "sqlite",
      db,
      schema: schemaSqlite,
      close: async () => {
        sqlite.close();
      },
    };
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Run the bootstrap on a dedicated connection so any per-connection state stays scoped.
  const init = await pool.connect();
  try {
    await init.query(SCHEMA_SQL_PG);
  } finally {
    init.release();
  }
  // PG's equivalent of `pragma foreign_keys = OFF` is `session_replication_role = replica`, which
  // takes effect per-session. Drizzle's connection pool reuses connections, so set it on each
  // acquired client. The simplest reliable hook is the pool's `connect` event — fires once per
  // physical connection added to the pool.
  pool.on("connect", (client) => {
    void client.query("SET session_replication_role = 'replica'").catch(() => {
      // Best-effort: if the role can't be elevated (e.g. on a read-replica), the writer will
      // raise an FK error on out-of-order inserts, which the caller already surfaces. We don't
      // want a noisy log here in tests.
    });
  });
  const db = drizzlePg(pool, { schema: schemaPg });
  return {
    dialect: "postgres",
    db,
    schema: schemaPg,
    close: async () => {
      await pool.end();
    },
  };
}

/** Open the dashboard DB read-only. SQLite uses `{ readonly: true }`; PG uses a default-tx-read-only pool. */
export async function openReadOnlyDbFromUrl(databaseUrl: string): Promise<DbHandle> {
  const dialect = detectDialect(databaseUrl);
  if (dialect === "sqlite") {
    const path = sqlitePathFromUrl(databaseUrl);
    if (!existsSync(path)) {
      throw new Error(`Bear Metal database file not found at "${path}"`);
    }
    const sqlite = new Database(path, { readonly: true, fileMustExist: true });
    const db = drizzleSqlite(sqlite, { schema: schemaSqlite });
    return {
      dialect: "sqlite",
      db,
      schema: schemaSqlite,
      close: async () => {
        sqlite.close();
      },
    };
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on("connect", (client) => {
    void client.query("SET default_transaction_read_only = on").catch(() => undefined);
  });
  const db = drizzlePg(pool, { schema: schemaPg });
  return {
    dialect: "postgres",
    db,
    schema: schemaPg,
    close: async () => {
      await pool.end();
    },
  };
}

export interface ReadOnlyDb {
  db: BetterSQLite3Database<typeof schemaSqlite>;
  sqlite: Database.Database;
}

/**
 * Legacy path-based opener. Kept as a thin wrapper over the URL factory so the writer/repository
 * call sites can migrate one at a time. New code should call `openWritableDbFromUrl` directly.
 */
export function openReadOnlyDb(path: string): ReadOnlyDb {
  if (!existsSync(path)) {
    throw new Error(`Bear Metal database file not found at "${path}"`);
  }
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  const db = drizzleSqlite(sqlite, { schema: schemaSqlite });
  return { db, sqlite };
}

/**
 * Legacy path-based read-write opener — kept for the same migration reason as `openReadOnlyDb`.
 * Note: FK enforcement is disabled here to match the writer-best-effort semantics of the URL
 * factory above. See `openWritableDbFromUrl` for the rationale.
 */
export function openReadWriteDb(path: string): ReadOnlyDb {
  if (!existsSync(path)) {
    throw new Error(`Bear Metal database file not found at "${path}"`);
  }
  const sqlite = new Database(path, { fileMustExist: true });
  sqlite.pragma("foreign_keys = OFF");
  const db = drizzleSqlite(sqlite, { schema: schemaSqlite });
  return { db, sqlite };
}

export type { DatabaseDialect };
