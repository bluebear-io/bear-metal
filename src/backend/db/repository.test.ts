import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers, listRepoBreakdowns } from "./repository.js";

let db: BetterSQLite3Database<typeof schema>;
beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
});

describe("listTickets", () => {
  it("returns all tickets newest-first with attempt + latest PR/CI summary", () => {
    const rows = listTickets(db);
    expect(rows.length).toBe(4);
    expect(rows[0]!.createdAt >= rows[1]!.createdAt).toBe(true);
    const createdAts = rows.map((r) => r.createdAt.getTime());
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
    const completed = rows.find((r) => r.identifier === "DEN-3001")!;
    expect(completed.bmStatus).toBe("completed");
    expect(completed.latestPr?.number).toBe(1500);
    expect(completed.latestCiStatus).toBe("passed");
    expect(completed.attemptCount).toBe(1);
  });

  it("includes the latest run summary for each ticket", () => {
    const rows = listTickets(db);
    const retry = rows.find((r) => r.identifier === "DEN-3002")!;
    expect(retry.latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });

    const abandoned = rows.find((r) => r.identifier === "DEN-3003")!;
    expect(abandoned.latestRun?.status).toBe("timed_out");
  });

  it("filters by bmStatus", () => {
    const rows = listTickets(db, { bmStatus: "abandoned" });
    expect(rows.map((r) => r.identifier)).toEqual(["DEN-3003"]);
  });
});

describe("getTicketDetail", () => {
  it("returns the ticket with runs, PRs, CI runs, and an ordered event timeline", () => {
    const detail = getTicketDetail(db, "lin_2")!;
    expect(detail.ticket.identifier).toBe("DEN-3002");
    expect(detail.runs.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(detail.runs[1]!.worker?.name).toBe("worker-2");
    expect(detail.pullRequests[0]!.number).toBe(1501);
    expect(detail.ciRuns.some((c) => c.status === "failed")).toBe(true);
    const eventTimes = detail.events.map((e) => e.createdAt.getTime());
    expect(eventTimes).toEqual([...eventTimes].sort((a, b) => a - b));
  });

  it("returns null for an unknown ticket", () => {
    expect(getTicketDetail(db, "nope")).toBeNull();
  });
});

describe("listRepoBreakdowns", () => {
  it("aggregates seeded PRs by repo with success rate and last activity", () => {
    const rows = listRepoBreakdowns(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.owner).toBe("bluebear-io");
    expect(row.repo).toBe("blueden");
    // pr_1 (lin_1, merged) + pr_2 (lin_2, not merged) → 2 distinct tickets, 1 merged.
    expect(row.ticketCount).toBe(2);
    expect(row.mergedCount).toBe(1);
    expect(row.successRate).toBeCloseTo(0.5);
    // tickets.attemptCount: lin_1 = 1, lin_2 = 2 → avg 1.5.
    expect(row.avgIterations).toBeCloseTo(1.5);
    // Latest of pr_1.updatedAt (07:55) and pr_2.updatedAt (08:46) → 08:46.
    expect(row.lastActivityAt?.toISOString()).toBe("2026-06-09T08:46:00.000Z");
  });

  it("excludes rows with empty owner/repo", () => {
    // Simulate a pre-migration PR row by clearing owner/repo on pr_2; it should drop out
    // of the breakdown but pr_1 (lin_1, merged) should remain the sole aggregate.
    db.update(schema.pullRequests).set({ owner: "", repo: "" }).where(eq(schema.pullRequests.id, "pr_2")).run();
    const rows = listRepoBreakdowns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticketCount).toBe(1);
    expect(rows[0]!.mergedCount).toBe(1);
    expect(rows[0]!.successRate).toBe(1);
  });
});

describe("listWorkers", () => {
  it("returns workers with their current ticket identifier when busy", () => {
    const rows = listWorkers(db, { now: new Date("2026-06-09T09:01:00Z") });
    expect(rows.length).toBe(3);
    const busy = rows.find((w) => w.id === "wk_1")!;
    expect(busy.status).toBe("busy");
    expect(busy.currentTicketIdentifier).toBe("DEN-3004");
    expect(busy.currentRun).toMatchObject({
      id: "run_in_1",
      ticketId: "lin_4",
      ticketIdentifier: "DEN-3004",
      ticketTitle: "Add CSV export to reports page",
      attemptNumber: 1,
      status: "running",
    });
    expect(busy.currentRun?.runtimeMs).toBe(6 * 60 * 1000);
    expect(busy.isDead).toBe(false);
    expect(busy.isTimedOut).toBe(false);
    expect(busy.isHeartbeatStale).toBe(false);

    const dead = rows.find((w) => w.id === "wk_3")!;
    expect(dead.isDead).toBe(true);
    expect(dead.isHeartbeatStale).toBe(true);
  });
});
