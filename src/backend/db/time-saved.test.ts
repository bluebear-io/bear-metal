import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { upsertTicket, upsertRun } from "./writer.js";
import { getTimeSavedSummary } from "./repository.js";
import { DEFAULT_HOURS_PER_COMPLEXITY } from "../config.js";

let db: BetterSQLite3Database<typeof schema>;

const baseTicket = {
  id: "lin_1",
  identifier: "DEN-1",
  title: "Add rate limiting",
  description: "Throttle per-key.",
  url: "https://linear/DEN-1",
  branchName: "feature/den-1",
  linearStatusName: "Done",
  linearStatusType: "completed",
  labels: ["bear-metal"],
  attemptCount: 1,
  maxAttempts: 5,
  createdAt: 1000,
  updatedAt: 2000,
  completedAt: 2000,
};

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
});

describe("upsertTicket complexity persistence", () => {
  it("computes and stores complexityScore + estimatedHumanHours on completion", () => {
    upsertTicket(db, { ...baseTicket, bmStatus: "completed" });
    const row = db.select().from(schema.tickets).get();
    expect(row?.complexityScore).toBe(1); // short description, attempt 1
    expect(row?.estimatedHumanHours).toBe(DEFAULT_HOURS_PER_COMPLEXITY[1]);
  });

  it("leaves columns null for non-completed tickets", () => {
    upsertTicket(db, { ...baseTicket, bmStatus: "in_progress", completedAt: null });
    const row = db.select().from(schema.tickets).get();
    expect(row?.complexityScore).toBeNull();
    expect(row?.estimatedHumanHours).toBeNull();
  });

  it("uses the overridden hours table when supplied", () => {
    const override = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 } as const;
    upsertTicket(db, { ...baseTicket, bmStatus: "completed" }, override);
    const row = db.select().from(schema.tickets).get();
    expect(row?.estimatedHumanHours).toBe(1);
  });
});

describe("getTimeSavedSummary", () => {
  it("returns empty totals when no completed tickets exist", () => {
    upsertTicket(db, { ...baseTicket, bmStatus: "in_progress", completedAt: null });
    const summary = getTimeSavedSummary(db);
    expect(summary.ticketCount).toBe(0);
    expect(summary.totalEstimatedHumanHours).toBe(0);
    expect(summary.totalActualBmHours).toBe(0);
    expect(summary.totalSavedHours).toBe(0);
    expect(summary.byTicket).toEqual([]);
  });

  it("aggregates totals and sorts per-ticket rows by savedHours desc", () => {
    // Ticket A: completed, complexity 1 → 0.5h estimated; one 30m run → 0.5h actual → 0h saved
    upsertTicket(db, { ...baseTicket, id: "lin_a", identifier: "DEN-A", bmStatus: "completed" });
    upsertRun(db, {
      id: "run_a", ticketId: "lin_a", attemptNumber: 1, workerId: null,
      trigger: "new", status: "succeeded", contextJson: null,
      startedAt: 0, endedAt: 30 * 60 * 1000, stopReason: "completed", error: null, createdAt: 0,
    });

    // Ticket B: completed, longer description → complexity 3 → 3h estimated; one 6m run → 0.1h actual → 2.9h saved
    const longDescription = "word ".repeat(200).trim();
    upsertTicket(db, {
      ...baseTicket, id: "lin_b", identifier: "DEN-B", description: longDescription, bmStatus: "completed",
    });
    upsertRun(db, {
      id: "run_b", ticketId: "lin_b", attemptNumber: 1, workerId: null,
      trigger: "new", status: "succeeded", contextJson: null,
      startedAt: 0, endedAt: 6 * 60 * 1000, stopReason: "completed", error: null, createdAt: 0,
    });

    // Ticket C: in_progress → ignored.
    upsertTicket(db, { ...baseTicket, id: "lin_c", identifier: "DEN-C", bmStatus: "in_progress", completedAt: null });

    const summary = getTimeSavedSummary(db);
    expect(summary.ticketCount).toBe(2);
    expect(summary.totalEstimatedHumanHours).toBeCloseTo(0.5 + 3.0, 5);
    expect(summary.totalActualBmHours).toBeCloseTo(0.5 + 0.1, 5);
    expect(summary.totalSavedHours).toBeCloseTo((0.5 - 0.5) + (3.0 - 0.1), 5);
    // Sorted by savedHours desc: B (2.9) before A (0)
    expect(summary.byTicket.map((r) => r.ticketIdentifier)).toEqual(["DEN-B", "DEN-A"]);
    expect(summary.byTicket[0]!.complexityScore).toBe(3);
    expect(summary.byTicket[0]!.savedHours).toBeCloseTo(2.9, 5);
  });

  it("reports actualBmHours null (and savedHours null) when no run has both timestamps", () => {
    upsertTicket(db, { ...baseTicket, bmStatus: "completed" });
    // Run with no startedAt/endedAt — not measurable.
    upsertRun(db, {
      id: "run_x", ticketId: "lin_1", attemptNumber: 1, workerId: null,
      trigger: "new", status: "dispatched", contextJson: null,
      startedAt: null, endedAt: null, stopReason: null, error: null, createdAt: 0,
    });
    const summary = getTimeSavedSummary(db);
    expect(summary.byTicket[0]!.actualBmHours).toBeNull();
    expect(summary.byTicket[0]!.savedHours).toBeNull();
    expect(summary.totalActualBmHours).toBe(0);
    expect(summary.totalSavedHours).toBe(0);
  });
});
