import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers, listRepoBreakdowns, getAnalytics } from "./repository.js";

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
  it("groups PRs by owner/repo with correct counts, success rate, avg iterations, and last activity", () => {
    const rows = listRepoBreakdowns(db);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.owner).toBe("bluebear-io");
    expect(r.repo).toBe("blueden");
    // lin_1 + lin_2 both have a PR in this repo.
    expect(r.ticketCount).toBe(2);
    // Only lin_1 has a merged PR.
    expect(r.mergedCount).toBe(1);
    expect(r.successRate).toBeCloseTo(0.5);
    // attemptCount: lin_1 = 1, lin_2 = 2 → avg 1.5
    expect(r.avgIterations).toBeCloseTo(1.5);
    expect(r.lastActivityAt?.toISOString()).toBe("2026-06-09T08:46:00.000Z");
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

describe("getAnalytics", () => {
  it("summarizes outcomes from the seeded tickets", () => {
    const a = getAnalytics(db, { now: new Date("2026-06-09T09:30:00Z") });
    // Seed: 4 tickets — 1 completed, 1 abandoned, 2 in-flight (ci_failed, in_progress).
    expect(a.outcomes).toMatchObject({
      total: 4,
      completed: 1,
      abandoned: 1,
      inFlight: 2,
    });
    expect(a.outcomes.successRate).toBeCloseTo(0.5);
    expect(a.outcomes.abandonmentRate).toBeCloseTo(0.5);
  });

  it("computes attempts distribution from decided tickets only", () => {
    const a = getAnalytics(db);
    // DEN-3001 completed @ 1 attempt; DEN-3003 abandoned @ 5 attempts. In-flight tickets excluded.
    expect(a.attemptsDistribution).toEqual([
      { attempts: 1, count: 1 },
      { attempts: 5, count: 1 },
    ]);
  });

  it("computes MTTR from completed tickets", () => {
    const a = getAnalytics(db);
    // DEN-3001 createdAt 07:05 → completedAt 07:55 = 50m = 3_000_000ms.
    expect(a.mttr.sampleSize).toBe(1);
    expect(a.mttr.meanMs).toBe(50 * 60 * 1000);
    expect(a.mttr.medianMs).toBe(50 * 60 * 1000);
    expect(a.mttr.p90Ms).toBe(50 * 60 * 1000);
  });

  it("returns a contiguous daily throughput series covering created and completed days", () => {
    const a = getAnalytics(db, { now: new Date("2026-06-09T23:00:00Z") });
    // Earliest createdAt is 2026-06-08; now is 2026-06-09 → 2 days.
    expect(a.throughput.map((p) => p.date)).toEqual(["2026-06-08", "2026-06-09"]);
    const byDate = new Map(a.throughput.map((p) => [p.date, p]));
    expect(byDate.get("2026-06-08")).toEqual({ date: "2026-06-08", created: 1, completed: 0 });
    // 3 tickets created on 2026-06-09; 1 completed (DEN-3001).
    expect(byDate.get("2026-06-09")).toEqual({ date: "2026-06-09", created: 3, completed: 1 });
  });
});
