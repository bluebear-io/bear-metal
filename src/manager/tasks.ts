import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

import type { RunTrigger } from "../shared/index.js";
import type { DispatchResult, DispatchState, PullRequestRef } from "../worker/index.js";

export const DEFAULT_DATABASE_URL = "sqlite:./bear-metal-manager.sqlite";

export interface DispatchTaskInput {
  state: DispatchState;
  ticketId: string;
  pr: PullRequestRef | null;
  trigger: RunTrigger;
  ticketIssueId: string;
}

export interface TaskRecord {
  id: string;
  ticketId: string;
  dispatchState: DispatchState;
  attemptNumber: number;
  input: DispatchTaskInput;
  workerId: string | null;
  resultStatus: DispatchResult["status"] | null;
  result: DispatchResult | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface TaskQueue {
  initialize(): Promise<void>;
  enqueue(input: DispatchTaskInput): Promise<TaskRecord>;
  acquireNext(workerId: string): Promise<TaskRecord | null>;
  complete(taskId: string, result: DispatchResult): Promise<void>;
  getCompleted(taskIds: string[]): Promise<TaskRecord[]>;
  close(): Promise<void>;
}

interface TaskRow {
  id: string;
  ticket_id: string;
  dispatch_state: string;
  attempt_number: number;
  input_json: string;
  worker_id: string | null;
  result_status: string | null;
  result_json: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}

export function createTaskQueueFromDatabaseUrl(databaseUrl: string): TaskQueue {
  if (databaseUrl.startsWith("sqlite:")) {
    return new SqliteTaskQueue(sqlitePath(databaseUrl));
  }
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    return new PostgresTaskQueue(databaseUrl);
  }
  throw new Error(`Unsupported DATABASE_URL scheme: ${databaseUrl}`);
}

class SqliteTaskQueue implements TaskQueue {
  private readonly path: string;
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async initialize(): Promise<void> {
    if (this.path !== ":memory:") {
      await mkdir(dirname(this.path), { recursive: true });
    }
    const db = new DatabaseSync(this.path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        dispatch_state TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        worker_id TEXT NULL,
        result_status TEXT NULL,
        result_json TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_acquire
        ON tasks(created_at)
        WHERE worker_id IS NULL AND result_status IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_completed
        ON tasks(id)
        WHERE result_status IS NOT NULL;
    `);
    this.db = db;
  }

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const db = this.requireDb();
    const id = randomUUID();
    const now = nowIso();
    const prior = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE ticket_id = ?").get(input.ticketId) as { c: number };
    const attemptNumber = prior.c + 1;
    db.prepare(`
      INSERT INTO tasks (
        id,
        ticket_id,
        dispatch_state,
        attempt_number,
        input_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.ticketId, input.state, attemptNumber, JSON.stringify(input), now, now);
    return rowToTask(this.getById(id));
  }

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    const db = this.requireDb();
    const now = nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = db.prepare(`
        SELECT id
        FROM tasks
        WHERE worker_id IS NULL AND result_status IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as { id: string } | undefined;
      if (!candidate) {
        db.exec("COMMIT");
        return null;
      }
      const result = db.prepare(`
        UPDATE tasks
        SET worker_id = ?, updated_at = ?
        WHERE id = ? AND worker_id IS NULL AND result_status IS NULL
      `).run(workerId, now, candidate.id);
      if (result.changes !== 1) {
        throw new Error(`Failed to acquire task: ${candidate.id}`);
      }
      const row = this.getById(candidate.id);
      db.exec("COMMIT");
      return rowToTask(row);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async complete(taskId: string, result: DispatchResult): Promise<void> {
    const db = this.requireDb();
    const now = nowIso();
    const update = db.prepare(`
      UPDATE tasks
      SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
    `).run(result.status, JSON.stringify(result), now, now, taskId);
    if (update.changes !== 1) {
      throw new Error(`Cannot complete task that is missing, unacquired, or already completed: ${taskId}`);
    }
  }

  async getCompleted(taskIds: string[]): Promise<TaskRecord[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM tasks
      WHERE id IN (${placeholders}) AND result_status IS NOT NULL
      ORDER BY completed_at ASC, created_at ASC
    `).all(...taskIds) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private getById(id: string): TaskRow {
    const row = this.requireDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) {
      throw new Error(`Task not found: ${id}`);
    }
    return row;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Task queue has not been initialized");
    }
    return this.db;
  }
}

class PostgresTaskQueue implements TaskQueue {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        dispatch_state TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        worker_id TEXT NULL,
        result_status TEXT NULL,
        result_json TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_acquire
        ON tasks(created_at)
        WHERE worker_id IS NULL AND result_status IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_completed
        ON tasks(id)
        WHERE result_status IS NOT NULL;
    `);
  }

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const id = randomUUID();
    const now = nowIso();
    const prior = await this.pool.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM tasks WHERE ticket_id = $1",
      [input.ticketId],
    );
    const attemptNumber = requireSingleRow(prior.rows, `attempt count for ${input.ticketId}`).c + 1;
    const result = await this.pool.query<TaskRow>(
      `
        INSERT INTO tasks (
          id,
          ticket_id,
          dispatch_state,
          attempt_number,
          input_json,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [id, input.ticketId, input.state, attemptNumber, JSON.stringify(input), now, now],
    );
    return rowToTask(requireSingleRow(result.rows, `inserted task ${id}`));
  }

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    const client = await this.pool.connect();
    const now = nowIso();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>(
        `
          WITH next_task AS (
            SELECT id
            FROM tasks
            WHERE worker_id IS NULL AND result_status IS NULL
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE tasks
          SET worker_id = $1, updated_at = $2
          FROM next_task
          WHERE tasks.id = next_task.id
          RETURNING tasks.*
        `,
        [workerId, now],
      );
      await client.query("COMMIT");
      return result.rows[0] ? rowToTask(result.rows[0]) : null;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async complete(taskId: string, result: DispatchResult): Promise<void> {
    const now = nowIso();
    const update = await this.pool.query(
      `
        UPDATE tasks
        SET result_status = $1, result_json = $2, updated_at = $3, completed_at = $4
        WHERE id = $5 AND worker_id IS NOT NULL AND result_status IS NULL
      `,
      [result.status, JSON.stringify(result), now, now, taskId],
    );
    if (update.rowCount !== 1) {
      throw new Error(`Cannot complete task that is missing, unacquired, or already completed: ${taskId}`);
    }
  }

  async getCompleted(taskIds: string[]): Promise<TaskRecord[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const result = await this.pool.query<TaskRow>(
      `
        SELECT *
        FROM tasks
        WHERE id = ANY($1::text[]) AND result_status IS NOT NULL
        ORDER BY completed_at ASC, created_at ASC
      `,
      [taskIds],
    );
    return result.rows.map(rowToTask);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function sqlitePath(databaseUrl: string): string {
  const path = databaseUrl.slice("sqlite:".length);
  if (!path) {
    throw new Error("SQLite DATABASE_URL must include a file path");
  }
  return path;
}

function rowToTask(row: TaskRow): TaskRecord {
  const resultStatus = parseResultStatus(row.result_status);
  return {
    id: row.id,
    ticketId: row.ticket_id,
    dispatchState: parseDispatchState(row.dispatch_state),
    attemptNumber: Number(row.attempt_number),
    input: parseTaskInput(row.input_json),
    workerId: row.worker_id,
    resultStatus,
    result: row.result_json === null ? null : parseDispatchResult(row.result_json),
    createdAt: parseTimestamp(row.created_at),
    updatedAt: parseTimestamp(row.updated_at),
    completedAt: row.completed_at === null ? null : parseTimestamp(row.completed_at),
  };
}

function parseTaskInput(value: string): DispatchTaskInput {
  const parsed = parseJsonObject(value, "task input_json");
  const state = parseDispatchState(parsed.state);
  const ticketId = requireString(parsed.ticketId, "task input ticketId");
  return {
    state,
    ticketId,
    pr: parsePullRequestRef(parsed.pr),
    trigger: parseTrigger(parsed.trigger),
    ticketIssueId: requireString(parsed.ticketIssueId, "task input ticketIssueId"),
  };
}

function parseTrigger(value: unknown): RunTrigger {
  if (value === "new" || value === "ci_failure" || value === "delegated_back") return value;
  throw new Error(`Invalid run trigger: ${String(value)}`);
}

function parseDispatchResult(value: string): DispatchResult {
  const parsed = parseJsonObject(value, "task result_json");
  return {
    status: requireResultStatus(parsed.status),
    pr: parsePullRequestRef(parsed.pr),
  };
}

function parsePullRequestRef(value: unknown): PullRequestRef | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error("Pull request ref must be null or an object");
  }
  const owner = requireString(value.owner, "pull request owner");
  const repo = requireString(value.repo, "pull request repo");
  const number = value.number;
  if (typeof number !== "number") {
    throw new Error("pull request number must be a positive integer");
  }
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  return { owner, repo, number };
}

function parseDispatchState(value: unknown): DispatchState {
  if (value === "new" || value === "iteration") {
    return value;
  }
  throw new Error(`Invalid dispatch state: ${String(value)}`);
}

function parseResultStatus(value: string | null): DispatchResult["status"] | null {
  if (value === null) {
    return null;
  }
  return requireResultStatus(value);
}

function requireResultStatus(value: unknown): DispatchResult["status"] {
  if (value === "pending" || value === "done") {
    return value;
  }
  throw new Error(`Invalid dispatch result status: ${String(value)}`);
}

function parseJsonObject(value: string, fieldName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function parseTimestamp(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireSingleRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Expected one row for ${context}`);
  }
  return row;
}
