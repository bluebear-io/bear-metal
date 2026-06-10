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
  prs: PullRequestRef[];
  trigger: RunTrigger;
  ticketIssueId: string;
}

export type SlotStatus = "active" | "parked" | "released";

export interface TaskRecord {
  id: string;
  ticketId: string;
  dispatchState: DispatchState;
  attemptNumber: number;
  input: DispatchTaskInput;
  workerId: string | null;
  resultStatus: DispatchResult["status"] | null;
  result: DispatchResult | null;
  slotStatus: SlotStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  releasedAt: Date | null;
  iterationNumber: number;
  /** Last time the owning worker proved liveness for this task. NULL while unacquired. */
  workerHeartbeatAt: Date | null;
  /** Number of times this task row has been recovered from a crashed/hung worker. */
  reclaimCount: number;
}

export type ReclaimAction = "reclaimed" | "abandoned";

export interface ReclaimResult {
  task: TaskRecord;
  action: ReclaimAction;
  reason: string;
  /** The worker that owned the row before recovery (cleared for `reclaimed`, preserved for `abandoned`). */
  previousWorkerId: string;
}

export interface ReclaimStaleOptions {
  /** A task is stale if its worker hasn't heartbeat within this many milliseconds. */
  staleAfterMs: number;
  /** After this many reclaims of the same row, give up and abandon (terminal pending + release). */
  maxReclaims: number;
}

export interface TaskSlot {
  ticketId: string;
  slotStatus: Exclude<SlotStatus, "released">;
  latestTask: TaskRecord;
}

export interface TaskQueue {
  initialize(): Promise<void>;
  enqueue(input: DispatchTaskInput): Promise<TaskRecord>;
  acquireNext(workerId: string): Promise<TaskRecord | null>;
  complete(taskId: string, result: DispatchResult): Promise<void>;
  listTracked(): Promise<TaskSlot[]>;
  countTracked(): Promise<number>;
  setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord>;
  /** Returns the number of tasks ever enqueued for this ticket (completed or not). */
  getIterationCount(ticketId: string): Promise<number>;
  /**
   * Touch the worker_heartbeat_at column to prove the owning worker is still alive.
   * Returns false when the task is no longer owned by `workerId` or has already completed —
   * a signal to the caller that it lost the lease (e.g. a reclaim already happened).
   */
  heartbeat(taskId: string, workerId: string): Promise<boolean>;
  /**
   * Find tasks whose worker stopped heartbeating and recover them. Rows under maxReclaims are
   * released for re-acquire (worker_id cleared, reclaim_count incremented). Rows at or over the
   * cap are abandoned: completed with status="pending" + slot released, so the scheduler re-admits
   * the ticket as a fresh start and MAX_ITERATIONS eventually bounds permanent loops.
   */
  reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]>;
  /**
   * Explicit crash signal from a worker whose runTask threw. Same recovery decision as
   * `reclaimStaleTasks`, applied to a single known row. Returns null when the row is no longer
   * owned by `workerId` or has already completed.
   */
  markCrashed(taskId: string, workerId: string, maxReclaims: number): Promise<ReclaimResult | null>;
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
  slot_status: string;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
  released_at: string | Date | null;
  iteration_number: number;
  worker_heartbeat_at: string | Date | null;
  reclaim_count: number;
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
  private readonly clock = new MonotonicIsoClock();
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
        slot_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NULL,
        released_at TEXT NULL,
        iteration_number INTEGER NOT NULL DEFAULT 1,
        worker_heartbeat_at TEXT NULL,
        reclaim_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    ensureSqliteColumn(db, "attempt_number", "INTEGER NOT NULL DEFAULT 1");
    ensureSqliteColumn(db, "slot_status", "TEXT NOT NULL DEFAULT 'active'");
    ensureSqliteColumn(db, "released_at", "TEXT NULL");
    ensureSqliteColumn(db, "iteration_number", "INTEGER NOT NULL DEFAULT 1");
    ensureSqliteColumn(db, "worker_heartbeat_at", "TEXT NULL");
    ensureSqliteColumn(db, "reclaim_count", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      DROP INDEX IF EXISTS idx_tasks_acquire;
      CREATE INDEX IF NOT EXISTS idx_tasks_acquire
        ON tasks(created_at)
        WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active';
      CREATE INDEX IF NOT EXISTS idx_tasks_completed
        ON tasks(id)
        WHERE result_status IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_latest
        ON tasks(ticket_id, created_at DESC);
    `);
    this.db = db;
  }

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const db = this.requireDb();
    const id = randomUUID();
    const now = this.clock.nowIso();
    // attempt_number and iteration_number both count prior tasks for this ticket; compute each
    // atomically via subquery so concurrent enqueues for the same ticket can't observe the same
    // pre-insert count (TOCTOU). Matches the Postgres path.
    db.prepare(`
      INSERT INTO tasks (
        id,
        ticket_id,
        dispatch_state,
        attempt_number,
        input_json,
        created_at,
        updated_at,
        iteration_number
      ) VALUES (
        ?, ?, ?,
        (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ?),
        ?, ?, ?,
        (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = ?)
      )
    `).run(id, input.ticketId, input.state, input.ticketId, JSON.stringify(input), now, now, input.ticketId);
    return rowToTask(this.getById(id));
  }

  async getIterationCount(ticketId: string): Promise<number> {
    const row = this.requireDb()
      .prepare("SELECT COUNT(*) as count FROM tasks WHERE ticket_id = ?")
      .get(ticketId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    const db = this.requireDb();
    const now = this.clock.nowIso();
    db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = db.prepare(`
        SELECT id
        FROM tasks
        WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as { id: string } | undefined;
      if (!candidate) {
        db.exec("COMMIT");
        return null;
      }
      const result = db.prepare(`
        UPDATE tasks
        SET worker_id = ?, updated_at = ?, worker_heartbeat_at = ?
        WHERE id = ? AND worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
      `).run(workerId, now, now, candidate.id);
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
    const now = this.clock.nowIso();
    const update = db.prepare(`
      UPDATE tasks
      SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?
      WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
    `).run(result.status, JSON.stringify(result), now, now, taskId);
    if (update.changes !== 1) {
      throw new Error(`Cannot complete task that is missing, unacquired, or already completed: ${taskId}`);
    }
  }

  async listTracked(): Promise<TaskSlot[]> {
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM (
        SELECT
          tasks.*,
          ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY created_at DESC, id DESC) AS row_number
        FROM tasks
      )
      WHERE row_number = 1 AND slot_status != 'released'
      ORDER BY created_at ASC, id ASC
    `).all() as unknown as TaskRow[];
    return rows.map(rowToSlot);
  }

  async countTracked(): Promise<number> {
    return (await this.listTracked()).length;
  }

  async setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord> {
    const latest = this.getLatestByTicketId(ticketId);
    if (!latest) {
      throw new Error(`Cannot set slot status for unknown ticket: ${ticketId}`);
    }
    const now = this.clock.nowIso();
    this.requireDb().prepare(`
      UPDATE tasks
      SET slot_status = ?, released_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status === "released" ? now : null, now, latest.id);
    return rowToTask(this.getById(latest.id));
  }

  async heartbeat(taskId: string, workerId: string): Promise<boolean> {
    const db = this.requireDb();
    const now = this.clock.nowIso();
    const result = db.prepare(`
      UPDATE tasks
      SET worker_heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND result_status IS NULL
    `).run(now, now, taskId, workerId);
    return result.changes === 1;
  }

  async reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]> {
    const db = this.requireDb();
    const threshold = new Date(Date.now() - options.staleAfterMs).toISOString();
    const candidates = db.prepare(`
      SELECT id
      FROM tasks
      WHERE worker_id IS NOT NULL
        AND result_status IS NULL
        AND worker_heartbeat_at IS NOT NULL
        AND worker_heartbeat_at < ?
      ORDER BY worker_heartbeat_at ASC
    `).all(threshold) as Array<{ id: string }>;
    const out: ReclaimResult[] = [];
    for (const candidate of candidates) {
      const row = this.getById(candidate.id);
      // Re-check under serial sqlite execution so a heartbeat racing in between SELECT and recovery
      // can't be overwritten.
      if (row.worker_id === null || row.result_status !== null) continue;
      const heartbeat = row.worker_heartbeat_at;
      if (heartbeat === null) continue;
      const heartbeatMs = parseTimestamp(heartbeat).getTime();
      if (Date.now() - heartbeatMs < options.staleAfterMs) continue;
      const reason = `worker ${row.worker_id} heartbeat stale since ${typeof heartbeat === "string" ? heartbeat : heartbeat.toISOString()}`;
      const recovered = this.applyRecovery(row, options.maxReclaims, reason);
      out.push(recovered);
    }
    return out;
  }

  async markCrashed(taskId: string, workerId: string, maxReclaims: number): Promise<ReclaimResult | null> {
    const row = this.requireDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) return null;
    if (row.worker_id !== workerId || row.result_status !== null) return null;
    return this.applyRecovery(row, maxReclaims, `worker ${workerId} reported crash`);
  }

  /**
   * Decide between releasing the row for re-acquire (under the cap) or abandoning it
   * (cap reached — mark terminal pending + release the slot). Runs synchronously under
   * sqlite's serialized execution so concurrent reclaim attempts can't both act.
   */
  private applyRecovery(row: TaskRow, maxReclaims: number, reason: string): ReclaimResult {
    const db = this.requireDb();
    const now = this.clock.nowIso();
    const previousWorkerId = row.worker_id ?? "unknown";
    if (row.reclaim_count + 1 < maxReclaims) {
      const update = db.prepare(`
        UPDATE tasks
        SET worker_id = NULL,
            worker_heartbeat_at = NULL,
            reclaim_count = reclaim_count + 1,
            updated_at = ?
        WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
      `).run(now, row.id);
      if (update.changes !== 1) {
        // Lost the race — someone else (heartbeat, complete, prior reclaim) changed the row.
        throw new Error(`Failed to release stale task ${row.id} for re-acquire`);
      }
      return { task: rowToTask(this.getById(row.id)), action: "reclaimed", reason, previousWorkerId };
    }
    // Cap reached: terminal pending + release slot. The ticket stays delegated, so the next
    // scheduler tick re-admits it as a fresh start; MAX_ITERATIONS bounds the outer loop.
    const synthetic: DispatchResult = { status: "pending", prs: [] };
    const abandon = db.prepare(`
      UPDATE tasks
      SET result_status = ?, result_json = ?, updated_at = ?, completed_at = ?,
          slot_status = 'released', released_at = ?
      WHERE id = ? AND worker_id IS NOT NULL AND result_status IS NULL
    `).run(synthetic.status, JSON.stringify(synthetic), now, now, now, row.id);
    if (abandon.changes !== 1) {
      // Lost the race — someone else (heartbeat, complete, prior reclaim) changed the row.
      throw new Error(`Failed to abandon stale task ${row.id}`);
    }
    return { task: rowToTask(this.getById(row.id)), action: "abandoned", reason, previousWorkerId };
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

  private getLatestByTicketId(ticketId: string): TaskRow | null {
    const row = this.requireDb().prepare(`
      SELECT *
      FROM tasks
      WHERE ticket_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(ticketId) as TaskRow | undefined;
    return row ?? null;
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
  private readonly clock = new MonotonicIsoClock();

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
        slot_status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NULL,
        released_at TIMESTAMPTZ NULL,
        iteration_number INTEGER NOT NULL DEFAULT 1,
        worker_heartbeat_at TIMESTAMPTZ NULL,
        reclaim_count INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS slot_status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS iteration_number INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_heartbeat_at TIMESTAMPTZ NULL;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reclaim_count INTEGER NOT NULL DEFAULT 0;
      DROP INDEX IF EXISTS idx_tasks_acquire;
      CREATE INDEX IF NOT EXISTS idx_tasks_acquire
        ON tasks(created_at)
        WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active';
      CREATE INDEX IF NOT EXISTS idx_tasks_completed
        ON tasks(id)
        WHERE result_status IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_latest
        ON tasks(ticket_id, created_at DESC);
    `);
  }

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const id = randomUUID();
    const now = this.clock.nowIso();
    // attempt_number and iteration_number both count prior tasks for this ticket; compute each
    // atomically via subquery so concurrent enqueues for the same ticket can't observe the same
    // pre-insert count (TOCTOU).
    const result = await this.pool.query<TaskRow>(
      `
        INSERT INTO tasks (
          id,
          ticket_id,
          dispatch_state,
          attempt_number,
          input_json,
          created_at,
          updated_at,
          iteration_number
        ) VALUES (
          $1, $2, $3,
          (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = $2),
          $4, $5, $6,
          (SELECT COUNT(*) + 1 FROM tasks WHERE ticket_id = $2)
        )
        RETURNING *
      `,
      [id, input.ticketId, input.state, JSON.stringify(input), now, now],
    );
    return rowToTask(requireSingleRow(result.rows, `inserted task ${id}`));
  }

  async getIterationCount(ticketId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM tasks WHERE ticket_id = $1",
      [ticketId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    const client = await this.pool.connect();
    const now = this.clock.nowIso();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>(
        `
          WITH next_task AS (
            SELECT id
            FROM tasks
            WHERE worker_id IS NULL AND result_status IS NULL AND slot_status = 'active'
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE tasks
          SET worker_id = $1, updated_at = $2, worker_heartbeat_at = $2
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
    const now = this.clock.nowIso();
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

  async listTracked(): Promise<TaskSlot[]> {
    const result = await this.pool.query<TaskRow>(`
      SELECT *
      FROM (
        SELECT DISTINCT ON (ticket_id) *
        FROM tasks
        ORDER BY ticket_id, created_at DESC, id DESC
      ) latest
      WHERE slot_status != 'released'
      ORDER BY created_at ASC, id ASC
    `);
    return result.rows.map(rowToSlot);
  }

  async countTracked(): Promise<number> {
    return (await this.listTracked()).length;
  }

  async setSlotStatus(ticketId: string, status: SlotStatus): Promise<TaskRecord> {
    const now = this.clock.nowIso();
    const result = await this.pool.query<TaskRow>(
      `
        WITH latest AS (
          SELECT id
          FROM tasks
          WHERE ticket_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
        UPDATE tasks
        SET slot_status = $2, released_at = $3, updated_at = $4
        FROM latest
        WHERE tasks.id = latest.id
        RETURNING tasks.*
      `,
      [ticketId, status, status === "released" ? now : null, now],
    );
    return rowToTask(requireSingleRow(result.rows, `latest task for ticket ${ticketId}`));
  }

  async heartbeat(taskId: string, workerId: string): Promise<boolean> {
    const now = this.clock.nowIso();
    const result = await this.pool.query(
      `
        UPDATE tasks
        SET worker_heartbeat_at = $1, updated_at = $1
        WHERE id = $2 AND worker_id = $3 AND result_status IS NULL
      `,
      [now, taskId, workerId],
    );
    return result.rowCount === 1;
  }

  async reclaimStaleTasks(options: ReclaimStaleOptions): Promise<ReclaimResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock candidate rows so concurrent reclaim attempts don't both act on the same row.
      const candidates = await client.query<TaskRow>(
        `
          SELECT *
          FROM tasks
          WHERE worker_id IS NOT NULL
            AND result_status IS NULL
            AND worker_heartbeat_at IS NOT NULL
            AND worker_heartbeat_at < (NOW() - ($1::bigint || ' milliseconds')::interval)
          ORDER BY worker_heartbeat_at ASC
          FOR UPDATE SKIP LOCKED
        `,
        [String(options.staleAfterMs)],
      );
      const out: ReclaimResult[] = [];
      for (const row of candidates.rows) {
        const heartbeat = row.worker_heartbeat_at;
        if (heartbeat === null) continue;
        const reason = `worker ${row.worker_id} heartbeat stale since ${typeof heartbeat === "string" ? heartbeat : heartbeat.toISOString()}`;
        out.push(await this.applyRecovery(client, row, options.maxReclaims, reason));
      }
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markCrashed(taskId: string, workerId: string, maxReclaims: number): Promise<ReclaimResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TaskRow>("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
      const row = result.rows[0];
      if (!row || row.worker_id !== workerId || row.result_status !== null) {
        await client.query("COMMIT");
        return null;
      }
      const recovered = await this.applyRecovery(client, row, maxReclaims, `worker ${workerId} reported crash`);
      await client.query("COMMIT");
      return recovered;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async applyRecovery(
    client: pg.PoolClient,
    row: TaskRow,
    maxReclaims: number,
    reason: string,
  ): Promise<ReclaimResult> {
    const now = this.clock.nowIso();
    const previousWorkerId = row.worker_id ?? "unknown";
    if (row.reclaim_count + 1 < maxReclaims) {
      const update = await client.query<TaskRow>(
        `
          UPDATE tasks
          SET worker_id = NULL,
              worker_heartbeat_at = NULL,
              reclaim_count = reclaim_count + 1,
              updated_at = $1
          WHERE id = $2 AND worker_id IS NOT NULL AND result_status IS NULL
          RETURNING *
        `,
        [now, row.id],
      );
      const updated = update.rows[0];
      if (!updated) {
        throw new Error(`Failed to release stale task ${row.id} for re-acquire`);
      }
      return { task: rowToTask(updated), action: "reclaimed", reason, previousWorkerId };
    }
    const synthetic: DispatchResult = { status: "pending", prs: [] };
    const update = await client.query<TaskRow>(
      `
        UPDATE tasks
        SET result_status = $1, result_json = $2, updated_at = $3, completed_at = $3,
            slot_status = 'released', released_at = $3
        WHERE id = $4 AND worker_id IS NOT NULL AND result_status IS NULL
        RETURNING *
      `,
      [synthetic.status, JSON.stringify(synthetic), now, row.id],
    );
    const updated = update.rows[0];
    if (!updated) {
      throw new Error(`Failed to abandon stale task ${row.id}`);
    }
    return { task: rowToTask(updated), action: "abandoned", reason, previousWorkerId };
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
    slotStatus: parseSlotStatus(row.slot_status),
    createdAt: parseTimestamp(row.created_at),
    updatedAt: parseTimestamp(row.updated_at),
    completedAt: row.completed_at === null ? null : parseTimestamp(row.completed_at),
    releasedAt: row.released_at === null ? null : parseTimestamp(row.released_at),
    iterationNumber: row.iteration_number,
    workerHeartbeatAt: row.worker_heartbeat_at === null || row.worker_heartbeat_at === undefined ? null : parseTimestamp(row.worker_heartbeat_at),
    reclaimCount: Number(row.reclaim_count ?? 0),
  };
}

function rowToSlot(row: TaskRow): TaskSlot {
  const latestTask = rowToTask(row);
  if (latestTask.slotStatus === "released") {
    throw new Error(`Released task cannot be tracked as an active slot: ${latestTask.id}`);
  }
  return {
    ticketId: latestTask.ticketId,
    slotStatus: latestTask.slotStatus,
    latestTask,
  };
}

function parseTaskInput(value: string): DispatchTaskInput {
  const parsed = parseJsonObject(value, "task input_json");
  const state = parseDispatchState(parsed.state);
  const ticketId = requireString(parsed.ticketId, "task input ticketId");
  return {
    state,
    ticketId,
    // Backward compat: rows written before the prs[] migration have a singular `pr` field.
    prs: Array.isArray(parsed.prs)
      ? parsePullRequestRefs(parsed.prs, "task input prs")
      : parsed.pr != null
        ? [parsePullRequestRef(parsed.pr, "task input pr (legacy)")]
        : [],
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
  // Backward compat: rows written before the prs[] migration have a singular `pr` field.
  const prs = Array.isArray(parsed.prs)
    ? parsePullRequestRefs(parsed.prs, "task result prs")
    : parsed.pr != null
      ? [parsePullRequestRef(parsed.pr, "task result pr (legacy)")]
      : [];
  return {
    status: requireResultStatus(parsed.status),
    prs,
  };
}

function parsePullRequestRefs(value: unknown, fieldName: string): PullRequestRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value.map((item, i) => parsePullRequestRef(item, `${fieldName}[${i}]`));
}

function parsePullRequestRef(value: unknown, fieldName: string): PullRequestRef {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const owner = requireString(value.owner, `${fieldName}.owner`);
  const repo = requireString(value.repo, `${fieldName}.repo`);
  const number = value.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName}.number must be a positive integer`);
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

function parseSlotStatus(value: unknown): SlotStatus {
  if (value === "active" || value === "parked" || value === "released") {
    return value;
  }
  throw new Error(`Invalid task slot status: ${String(value)}`);
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

class MonotonicIsoClock {
  private lastNowMs = 0;

  nowIso(): string {
    const nowMs = Date.now();
    const monotonicMs = Math.max(nowMs, this.lastNowMs + 1);
    this.lastNowMs = monotonicMs;
    return new Date(monotonicMs).toISOString();
  }
}

function requireSingleRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Expected one row for ${context}`);
  }
  return row;
}

function ensureSqliteColumn(db: DatabaseSync, columnName: string, definition: string): void {
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${definition}`);
}
