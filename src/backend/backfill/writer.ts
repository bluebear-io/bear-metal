import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { BACKFILL_WORKER_ID } from "./mapper.js";
import type { RowBundle } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface WriteResult {
  written: boolean;
}

/**
 * Upsert the synthetic worker row every backfilled run references. Safe to call on every tool
 * invocation — bumps `startedAt`/`updatedAt` to the current time but otherwise leaves the row
 * untouched.
 */
export function ensureBackfillWorker(db: Db, now: Date = new Date()): void {
  db.insert(schema.workers)
    .values({
      id: BACKFILL_WORKER_ID,
      name: "backfill",
      status: "stopped",
      currentRunId: null,
      lastHeartbeatAt: null,
      startedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.workers.id,
      set: { startedAt: now, updatedAt: now },
    })
    .run();
}

/**
 * Insert a full ticket bundle in one transaction. Skip-on-conflict: if a `tickets` row with the
 * same id already exists, nothing in the bundle is written. The caller relies on this to make
 * re-runs of the backfill tool idempotent without explicit cursor tracking.
 */
export function writeBundle(db: Db, bundle: RowBundle): WriteResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, bundle.ticket.id))
      .get();
    if (existing) {
      return { written: false };
    }

    tx.insert(schema.tickets).values(bundle.ticket).run();
    if (bundle.runs.length > 0) {
      tx.insert(schema.runs).values(bundle.runs).run();
    }
    if (bundle.pullRequests.length > 0) {
      tx.insert(schema.pullRequests).values(bundle.pullRequests).run();
    }
    if (bundle.ciRuns.length > 0) {
      tx.insert(schema.ciRuns).values(bundle.ciRuns).run();
    }
    if (bundle.events.length > 0) {
      tx.insert(schema.events).values(bundle.events).run();
    }
    return { written: true };
  });
}
