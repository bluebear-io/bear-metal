import pg from "pg";
import type { DatabaseClient } from "./types.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export interface PostgresClientOptions {
  connectionString: string;
}

export class PostgresClient implements DatabaseClient {
  private readonly pool: pg.Pool;

  constructor(opts: PostgresClientOptions) {
    this.pool = new pg.Pool({ connectionString: opts.connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(CREATE_TABLE_SQL);
  }

  async createTaskInProgress(ticketId: string): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      "INSERT INTO tasks (ticket_id, status) VALUES ($1, $2) RETURNING id",
      [ticketId, "in_progress"],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Postgres INSERT into tasks returned no rows");
    }
    return row.id;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
