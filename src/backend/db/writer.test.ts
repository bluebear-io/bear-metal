import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { upsertTicket, upsertRun, upsertWorker, insertEvent } from "./writer.js";

let db: BetterSQLite3Database<typeof schema>;
beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
});

const ticket = {
  id: "lin_9", identifier: "DEN-9", title: "t", description: null, url: "u",
  branchName: "b", linearStatusName: "Todo", linearStatusType: "unstarted",
  labels: ["bear-metal"], bmStatus: "discovered" as const, attemptCount: 0,
  maxAttempts: 5, createdAt: 1000, updatedAt: 1000, completedAt: null,
};

describe("upsertTicket", () => {
  it("inserts then updates the same id (idempotent)", () => {
    upsertTicket(db, ticket);
    upsertTicket(db, { ...ticket, bmStatus: "in_progress", updatedAt: 2000 });
    const rows = db.select().from(schema.tickets).where(eq(schema.tickets.id, "lin_9")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bmStatus).toBe("in_progress");
    expect(rows[0]!.labelsJson).toBe(JSON.stringify(["bear-metal"]));
    expect(rows[0]!.updatedAt).toEqual(new Date(2000));
  });
});

describe("upsertRun + insertEvent", () => {
  it("persists a run and appends an event", () => {
    upsertTicket(db, ticket);
    upsertRun(db, {
      id: "run_9", ticketId: "lin_9", attemptNumber: 1, workerId: null,
      trigger: "new", status: "dispatched", contextJson: null,
      startedAt: null, endedAt: null, stopReason: null, error: null,
      promptTokens: null, completionTokens: null, modelName: null, provider: null,
      createdAt: 1500,
    });
    insertEvent(db, {
      ticketId: "lin_9", runId: "run_9", workerId: null, source: "manager",
      type: "dispatched", summary: "enqueued", payloadJson: null, createdAt: 1500,
    });
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });

  it("upsertRun preserves createdAt (immutable) and startedAt (set-once) across transitions", () => {
    upsertTicket(db, ticket);
    upsertWorker(db, { id: "wk_1", name: "w", status: "busy", currentRunId: null, lastHeartbeatAt: null, startedAt: 1000, updatedAt: 1000 }); // FK target for run.workerId
    // dispatched: no start time, created at t0
    upsertRun(db, { id: "run_lc", ticketId: "lin_9", attemptNumber: 1, workerId: null, trigger: "new", status: "dispatched", contextJson: null, startedAt: null, endedAt: null, stopReason: null, error: null, promptTokens: null, completionTokens: null, modelName: null, provider: null, createdAt: 1000 });
    // running: sets startedAt
    upsertRun(db, { id: "run_lc", ticketId: "lin_9", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "running", contextJson: null, startedAt: 2000, endedAt: null, stopReason: null, error: null, promptTokens: null, completionTokens: null, modelName: null, provider: null, createdAt: 2000 });
    // succeeded: sends startedAt=null and a later createdAt — must NOT clobber
    upsertRun(db, { id: "run_lc", ticketId: "lin_9", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded", contextJson: null, startedAt: null, endedAt: 3000, stopReason: "completed", error: null, promptTokens: 1000, completionTokens: 200, modelName: "claude-sonnet-4", provider: "anthropic", createdAt: 3000 });

    const rows = db.select().from(schema.runs).where(eq(schema.runs.id, "run_lc")).all();
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.createdAt).toEqual(new Date(1000));   // immutable: original dispatch time
    expect(run.startedAt).toEqual(new Date(2000));    // set-once: preserved from the running write
    expect(run.endedAt).toEqual(new Date(3000));
  });
});
