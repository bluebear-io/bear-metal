import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import Database from "better-sqlite3";
import pg from "pg";

import { createLogger, type Logger } from "../shared/index.js";

const defaultLogger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:db",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

export const TASK_STATUS = {
  IN_PROGRESS: "in_progress",
  DONE: "done",
  FAILED: "failed",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

interface TasksTable {
  ticket_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface BearMetalSchema {
  tasks: TasksTable;
}

export interface DatabaseEnv {
  /** Connection URL for an existing SQL server. Today only postgres is supported. */
  DATABASE_URL?: string;
  /** Path used when no DATABASE_URL is set. Defaults to `./bear-metal.sqlite`. */
  SQLITE_PATH?: string;
}

export interface CreateDatabaseOptions {
  env?: DatabaseEnv;
  logger?: Logger;
}

/**
 * Thin wrapper around Kysely that owns bear-metal's task tracking schema.
 *
 * Schema is created lazily on `init()` so callers don't need separate migrations
 * for the sqlite fallback case. For a postgres server, the same `IF NOT EXISTS`
 * DDL runs and is a no-op once provisioned.
 */
export class BearMetalDatabase {
  constructor(
    private readonly db: Kysely<BearMetalSchema>,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await this.db.schema
      .createTable("tasks")
      .ifNotExists()
      .addColumn("ticket_id", "text", (c) => c.primaryKey())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .execute();
    this.logger.debug("tasks table ready");
  }

  /**
   * Record (or refresh) a task as `in_progress`. Used at dispatch time so the
   * manager has a durable record of the current ticket's state independent of
   * Linear / GitHub APIs.
   *
   * Re-running the same ticket (state="new" replay) must be idempotent: upsert
   * via `ON CONFLICT` and refresh `updated_at`.
   */
  async recordTaskInProgress(ticketId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("tasks")
      .values({
        ticket_id: ticketId,
        status: TASK_STATUS.IN_PROGRESS,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("ticket_id").doUpdateSet({
          status: TASK_STATUS.IN_PROGRESS,
          updated_at: now,
        }),
      )
      .execute();
    this.logger.info({ ticketId, status: TASK_STATUS.IN_PROGRESS }, "task recorded");
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  /** Exposed for tests. */
  get kysely(): Kysely<BearMetalSchema> {
    return this.db;
  }
}

const DEFAULT_SQLITE_PATH = "./bear-metal.sqlite";

/**
 * Build a `BearMetalDatabase` from environment configuration.
 *
 * - If `DATABASE_URL` is set it must be a postgres URL (`postgres://` or
 *   `postgresql://`). Other dialects are not supported yet — fail fast instead
 *   of silently falling back to sqlite.
 * - Otherwise, open / create a local sqlite file at `SQLITE_PATH` (default
 *   `./bear-metal.sqlite`).
 */
export function createDatabase(options: CreateDatabaseOptions = {}): BearMetalDatabase {
  const env = options.env ?? (process.env as DatabaseEnv);
  const logger = options.logger ?? defaultLogger;

  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      throw new Error(
        `DATABASE_URL must use a postgres:// or postgresql:// scheme. Other SQL servers are not supported yet. Got: ${url}`,
      );
    }
    const pool = new pg.Pool({ connectionString: url });
    const db = new Kysely<BearMetalSchema>({
      dialect: new PostgresDialect({ pool }),
    });
    logger.info({ driver: "postgres" }, "database client created");
    return new BearMetalDatabase(db, logger);
  }

  const path = env.SQLITE_PATH?.trim() || DEFAULT_SQLITE_PATH;
  const sqlite = new Database(path);
  const db = new Kysely<BearMetalSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  logger.info({ driver: "sqlite", path }, "database client created");
  return new BearMetalDatabase(db, logger);
}

export { sql };
