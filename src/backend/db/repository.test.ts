import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers, getWorkersTimeline } from "./repository.js";

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

describe("getWorkersTimeline", () => {
  // Anchor `now` past every seeded transition so the synthetic data is fully inside the window.
  const now = new Date("2026-06-09T09:30:00Z");

  it("reconstructs per-worker segments from recorded transitions", () => {
    const timelines = getWorkersTimeline(db, { now, windowMs: 24 * 60 * 60 * 1000 });
    const wk1 = timelines.find((t) => t.workerId === "wk_1")!;
    expect(wk1.workerName).toBe("worker-1");
    expect(wk1.segments.map((s) => s.status)).toEqual(["idle", "busy", "idle", "busy"]);
    // Last segment is open-ended and clipped to `now`.
    expect(wk1.segments.at(-1)!.endMs).toBe(now.getTime());
    // Segments are non-overlapping and chronological.
    for (let i = 1; i < wk1.segments.length; i++) {
      expect(wk1.segments[i]!.startMs).toBeGreaterThanOrEqual(wk1.segments[i - 1]!.endMs);
    }
  });

  it("seeds the first segment from the most recent transition before the window", () => {
    // 1h window, starting after worker-1's last 'busy' transition (08:00 UTC).
    const tightNow = new Date("2026-06-09T09:30:00Z");
    const timelines = getWorkersTimeline(db, { now: tightNow, windowMs: 60 * 60 * 1000 });
    const wk1 = timelines.find((t) => t.workerId === "wk_1")!;
    expect(wk1.segments).toHaveLength(1);
    expect(wk1.segments[0]!.status).toBe("busy");
    expect(wk1.segments[0]!.startMs).toBe(tightNow.getTime() - 60 * 60 * 1000);
    expect(wk1.segments[0]!.endMs).toBe(tightNow.getTime());
  });

  it("omits workers with no recorded transitions", () => {
    db.delete(schema.workerStatusTransitions).run();
    const timelines = getWorkersTimeline(db, { now, windowMs: 24 * 60 * 60 * 1000 });
    expect(timelines).toEqual([]);
  });
});
