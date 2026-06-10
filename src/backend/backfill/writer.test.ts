import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { BACKFILL_WORKER_ID } from "./mapper.js";
import type { RowBundle } from "./types.js";
import { ensureBackfillWorker, writeBundle } from "./writer.js";

const T = (iso: string) => new Date(iso);

function makeBundle(id: string, withPr = true): RowBundle {
  const runs = withPr
    ? [
        {
          id: `run_backfill_${id}_0`,
          ticketId: id,
          attemptNumber: 1,
          workerId: BACKFILL_WORKER_ID,
          trigger: "new" as const,
          status: "succeeded" as const,
          contextJson: null,
          startedAt: T("2026-01-01T00:00:00Z"),
          endedAt: T("2026-01-02T00:00:00Z"),
          stopReason: "completed" as const,
          error: null,
          createdAt: T("2026-01-01T00:00:00Z"),
        },
      ]
    : [];

  return {
    ticket: {
      id,
      identifier: id.toUpperCase(),
      title: `Ticket ${id}`,
      description: null,
      url: `https://linear.app/${id}`,
      branchName: `feature/${id}`,
      linearStatusName: "Done",
      linearStatusType: "completed",
      labelsJson: "[]",
      bmStatus: withPr ? "completed" : "discovered",
      attemptCount: runs.length,
      maxAttempts: 5,
      createdAt: T("2026-01-01T00:00:00Z"),
      updatedAt: T("2026-01-02T00:00:00Z"),
      completedAt: withPr ? T("2026-01-02T00:00:00Z") : null,
    },
    runs,
    pullRequests: withPr
      ? [
          {
            id: `pr_acme_x_1_${id}`,
            ticketId: id,
            number: 1,
            title: "PR",
            headRef: `feature/${id}`,
            state: "closed" as const,
            draft: false,
            merged: true,
            url: "https://github.com/acme/x/pull/1",
            lastRunId: `run_backfill_${id}_0`,
            createdAt: T("2026-01-01T00:00:00Z"),
            updatedAt: T("2026-01-02T00:00:00Z"),
          },
        ]
      : [],
    ciRuns: [],
    events: [
      {
        id: `ev_backfill_${id}_0`,
        ticketId: id,
        runId: runs[0]?.id ?? null,
        workerId: null,
        source: "manager" as const,
        type: "ticket_discovered" as const,
        summary: `${id} discovered`,
        payloadJson: null,
        createdAt: T("2026-01-01T00:00:00Z"),
      },
    ],
  };
}

let db: BetterSQLite3Database<typeof schema>;
let handle: import("../db/client.js").DbHandle;

beforeEach(async () => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  handle = { dialect: "sqlite", db, schema, close: async () => undefined };
  await ensureBackfillWorker(handle, T("2026-06-10T00:00:00Z"));
});

describe("ensureBackfillWorker", () => {
  it("inserts the backfill worker on first call", () => {
    const rows = db.select().from(schema.workers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(BACKFILL_WORKER_ID);
    expect(rows[0]?.status).toBe("stopped");
  });

  it("updates the timestamps on subsequent calls without raising", async () => {
    await ensureBackfillWorker(handle, T("2026-06-11T00:00:00Z"));
    const rows = db.select().from(schema.workers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt.toISOString()).toBe("2026-06-11T00:00:00.000Z");
  });
});

describe("writeBundle", () => {
  it("writes the full bundle on first call", async () => {
    const result = await writeBundle(handle, makeBundle("lin_a"));
    expect(result.written).toBe(true);
    expect(db.select().from(schema.tickets).all()).toHaveLength(1);
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
    expect(db.select().from(schema.pullRequests).all()).toHaveLength(1);
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });

  it("returns written=false when the ticket already exists and inserts nothing", async () => {
    await writeBundle(handle, makeBundle("lin_a"));
    const second = await writeBundle(handle, makeBundle("lin_a"));
    expect(second.written).toBe(false);
    expect(db.select().from(schema.tickets).all()).toHaveLength(1);
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
    expect(db.select().from(schema.pullRequests).all()).toHaveLength(1);
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });

  it("writes a different ticket independently when one already exists", async () => {
    await writeBundle(handle, makeBundle("lin_a"));
    const second = await writeBundle(handle, makeBundle("lin_b"));
    expect(second.written).toBe(true);
    expect(db.select().from(schema.tickets).all()).toHaveLength(2);
  });

  it("inserts ticket-only bundles (no PR/CI/events) cleanly", async () => {
    const result = await writeBundle(handle, makeBundle("lin_c", false));
    expect(result.written).toBe(true);
    expect(db.select().from(schema.tickets).all()).toHaveLength(1);
    expect(db.select().from(schema.runs).all()).toHaveLength(0);
    expect(db.select().from(schema.pullRequests).all()).toHaveLength(0);
  });
});
