import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { createRepository, type Repository } from "./repository.js";
import { createWriter } from "./writer.js";

let db: BetterSQLite3Database<typeof schema>;
let repo: Repository;
beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
  repo = createRepository({ dialect: "sqlite", db, schema, close: async () => undefined });
});

describe("listTickets", () => {
  it("returns all tickets newest-first with attempt + latest PR/CI summary", async () => {
    const rows = await repo.listTickets();
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

  it("includes the latest run summary for each ticket", async () => {
    const rows = await repo.listTickets();
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

  it("filters by bmStatus", async () => {
    const rows = await repo.listTickets({ bmStatus: "abandoned" });
    expect(rows.map((r) => r.identifier)).toEqual(["DEN-3003"]);
  });
});

describe("getTicketDetail", () => {
  it("returns the ticket with runs, PRs, CI runs, and an ordered event timeline", async () => {
    const detail = (await repo.getTicketDetail("lin_2"))!;
    expect(detail.ticket.identifier).toBe("DEN-3002");
    expect(detail.runs.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(detail.runs[1]!.worker?.name).toBe("worker-2");
    expect(detail.pullRequests[0]!.number).toBe(1501);
    expect(detail.ciRuns.some((c) => c.status === "failed")).toBe(true);
    const eventTimes = detail.events.map((e) => e.createdAt.getTime());
    expect(eventTimes).toEqual([...eventTimes].sort((a, b) => a - b));
  });

  it("returns null for an unknown ticket", async () => {
    expect(await repo.getTicketDetail("nope")).toBeNull();
  });
});

describe("listWorkers", () => {
  it("returns workers with their current ticket identifier when busy", async () => {
    const rows = await repo.listWorkers({ now: new Date("2026-06-09T09:01:00Z") });
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

describe("getWorkerTimeline", () => {
  it("returns one open span per existing worker when no transitions were recorded", async () => {
    // The mock seeder bypasses the Writer, so no transition rows exist; the timeline should
    // still list every worker with an empty span set rather than dropping them.
    const timeline = await repo.getWorkerTimeline({
      from: new Date("2026-06-08T09:00:00Z"),
      to: new Date("2026-06-09T09:00:00Z"),
    });
    expect(timeline.workers.map((w) => w.workerId).sort()).toEqual(["wk_1", "wk_2", "wk_3"]);
    for (const w of timeline.workers) expect(w.spans).toEqual([]);
  });

  it("records transitions through the writer and reconstructs the span list ordered by startedAt", async () => {
    const writer = createWriter({ dialect: "sqlite", db, schema, close: async () => undefined });
    // First upsert opens the initial idle span at startedAt=t0.
    await writer.upsertWorker({ id: "wk_new", name: "worker-new", status: "idle", currentRunId: null, lastHeartbeatAt: 1000, startedAt: 1000, updatedAt: 1000 });
    // Same status — must NOT open a new span.
    await writer.upsertWorker({ id: "wk_new", name: "worker-new", status: "idle", currentRunId: null, lastHeartbeatAt: 1500, startedAt: 1000, updatedAt: 1500 });
    // idle → busy at t=2000.
    await writer.upsertWorker({ id: "wk_new", name: "worker-new", status: "busy", currentRunId: "r1", lastHeartbeatAt: 2000, startedAt: 1000, updatedAt: 2000 });
    // busy → dead at t=3000.
    await writer.upsertWorker({ id: "wk_new", name: "worker-new", status: "dead", currentRunId: null, lastHeartbeatAt: 3000, startedAt: 1000, updatedAt: 3000 });

    const timeline = await repo.getWorkerTimeline({ from: new Date(500), to: new Date(4000) });
    const row = timeline.workers.find((w) => w.workerId === "wk_new")!;
    expect(row.spans).toEqual([
      { status: "idle", startedAt: new Date(1000), endedAt: new Date(2000) },
      { status: "busy", startedAt: new Date(2000), endedAt: new Date(3000) },
      { status: "dead", startedAt: new Date(3000), endedAt: null },
    ]);
  });

  it("clamps span starts to the window's `from` and excludes spans that ended before the window", async () => {
    const writer = createWriter({ dialect: "sqlite", db, schema, close: async () => undefined });
    await writer.upsertWorker({ id: "wk_clamp", name: "w", status: "idle", currentRunId: null, lastHeartbeatAt: 1000, startedAt: 1000, updatedAt: 1000 });
    await writer.upsertWorker({ id: "wk_clamp", name: "w", status: "busy", currentRunId: null, lastHeartbeatAt: 5000, startedAt: 1000, updatedAt: 5000 });
    await writer.upsertWorker({ id: "wk_clamp", name: "w", status: "idle", currentRunId: null, lastHeartbeatAt: 8000, startedAt: 1000, updatedAt: 8000 });

    // Window [4000, 9000): the first idle span [1000,5000) overlaps and is clamped to 4000;
    // the busy span [5000,8000) is fully inside; the open idle span starts at 8000.
    const timeline = await repo.getWorkerTimeline({ from: new Date(4000), to: new Date(9000) });
    const row = timeline.workers.find((w) => w.workerId === "wk_clamp")!;
    expect(row.spans).toEqual([
      { status: "idle", startedAt: new Date(4000), endedAt: new Date(5000) },
      { status: "busy", startedAt: new Date(5000), endedAt: new Date(8000) },
      { status: "idle", startedAt: new Date(8000), endedAt: null },
    ]);

    // Window [6000, 7000): only the middle busy span overlaps.
    const inner = await repo.getWorkerTimeline({ from: new Date(6000), to: new Date(7000) });
    const innerRow = inner.workers.find((w) => w.workerId === "wk_clamp")!;
    expect(innerRow.spans).toEqual([
      { status: "busy", startedAt: new Date(6000), endedAt: new Date(8000) },
    ]);
  });
});
