import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { BACKFILL_WORKER_ID } from "./mapper.js";
import type { RowBundle } from "./types.js";

export interface WriteResult {
  written: boolean;
}

/**
 * Upsert the synthetic worker row every backfilled run references. Safe to call on every tool
 * invocation — bumps `startedAt`/`updatedAt` to the current time but otherwise leaves the row
 * untouched.
 */
export async function ensureBackfillWorker(handle: DbHandle, now: Date = new Date()): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = handle.db as any;
  const tables = handle.schema;
  await db
    .insert(tables.workers)
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
      target: tables.workers.id,
      set: { startedAt: now, updatedAt: now },
    });
}

/**
 * Insert a full ticket bundle in one transaction. Skip-on-conflict: if a `tickets` row with the
 * same id already exists, nothing in the bundle is written. The caller relies on this to make
 * re-runs of the backfill tool idempotent without explicit cursor tracking.
 *
 * Both dialects' `db.transaction(fn)` accept an async callback (Drizzle's pg path is natively
 * async; the sqlite path wraps the body in better-sqlite3's synchronous transaction internally).
 * The body uses `await` throughout for portability.
 */
export async function writeBundle(handle: DbHandle, bundle: RowBundle): Promise<WriteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = handle.schema as any;

  // Drizzle's transaction-callback signature is sync on better-sqlite3 (must return T, not
  // Promise<T>) and async on node-postgres. We can't share one closure. Both dialects accept
  // identical SELECT/INSERT chains, so we duplicate the transaction body once per dialect.
  if (handle.dialect === "sqlite") {
    return handle.db.transaction((tx) => {
      const existing = tx
        .select({ id: tables.tickets.id })
        .from(tables.tickets)
        .where(eq(tables.tickets.id, bundle.ticket.id))
        .limit(1)
        .all();
      if (existing.length > 0) return { written: false };
      tx.insert(tables.tickets).values(bundle.ticket).run();
      if (bundle.runs.length > 0) tx.insert(tables.runs).values(bundle.runs).run();
      if (bundle.pullRequests.length > 0) tx.insert(tables.pullRequests).values(bundle.pullRequests).run();
      if (bundle.ciRuns.length > 0) tx.insert(tables.ciRuns).values(bundle.ciRuns).run();
      if (bundle.events.length > 0) tx.insert(tables.events).values(bundle.events).run();
      return { written: true };
    });
  }
  return handle.db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: tables.tickets.id })
      .from(tables.tickets)
      .where(eq(tables.tickets.id, bundle.ticket.id))
      .limit(1);
    if (existing.length > 0) return { written: false };
    await tx.insert(tables.tickets).values(bundle.ticket);
    if (bundle.runs.length > 0) await tx.insert(tables.runs).values(bundle.runs);
    if (bundle.pullRequests.length > 0) await tx.insert(tables.pullRequests).values(bundle.pullRequests);
    if (bundle.ciRuns.length > 0) await tx.insert(tables.ciRuns).values(bundle.ciRuns);
    if (bundle.events.length > 0) await tx.insert(tables.events).values(bundle.events);
    return { written: true };
  });
}
