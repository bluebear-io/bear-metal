export type TaskStatus = "in_progress" | "done" | "failed";

export interface TaskRow {
  id: number;
  ticket_id: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Minimal cross-dialect interface for the worker's task tracking.
 *
 * Two backends: sqlite (default, local file) and postgres (set DATABASE_URL).
 * Schema is created lazily by `init()` so callers don't need to run migrations
 * separately. `tasks.id` is dialect-native (sqlite INTEGER PK, postgres SERIAL).
 */
export interface DatabaseClient {
  init(): Promise<void>;
  /** Insert a new row in `tasks` for `ticketId` with status='in_progress'. Returns row id. */
  createTaskInProgress(ticketId: string): Promise<number>;
  close(): Promise<void>;
}

export type DatabaseDriver = "sqlite" | "postgres";
