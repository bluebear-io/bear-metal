import { DatabaseSync } from "node:sqlite";
import type { DatabaseClient } from "./types.js";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface SqliteClientOptions {
  path: string;
}

export class SqliteClient implements DatabaseClient {
  private readonly db: DatabaseSync;

  constructor(opts: SqliteClientOptions) {
    this.db = new DatabaseSync(opts.path);
  }

  async init(): Promise<void> {
    this.db.exec(CREATE_TABLE_SQL);
  }

  async createTaskInProgress(ticketId: string): Promise<number> {
    const stmt = this.db.prepare("INSERT INTO tasks (ticket_id, status) VALUES (?, ?)");
    const info = stmt.run(ticketId, "in_progress");
    return Number(info.lastInsertRowid);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
