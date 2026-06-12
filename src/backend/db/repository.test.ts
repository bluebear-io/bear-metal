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
    const { items, total, page, pageSize } = await repo.listTickets();
    expect(items.length).toBe(4);
    expect(total).toBe(4);
    expect(page).toBe(1);
    expect(pageSize).toBe(50);
    expect(items[0]!.createdAt >= items[1]!.createdAt).toBe(true);
    const createdAts = items.map((r) => r.createdAt.getTime());
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
    const completed = items.find((r) => r.identifier === "DEN-3001")!;
    expect(completed.bmStatus).toBe("completed");
    expect(completed.latestPr?.number).toBe(1500);
    expect(completed.latestCiStatus).toBe("passed");
    expect(completed.attemptCount).toBe(1);
    expect(completed.latestWorkerName).toBe("worker-1");
    expect(completed.latestRun?.stopReason).toBe("completed");
  });

  it("includes the latest run summary for each ticket", async () => {
    const { items } = await repo.listTickets();
    const retry = items.find((r) => r.identifier === "DEN-3002")!;
    expect(retry.latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });

    const abandoned = items.find((r) => r.identifier === "DEN-3003")!;
    expect(abandoned.latestRun?.status).toBe("timed_out");
    expect(abandoned.latestRun?.stopReason).toBe("timeout");
  });

  it("filters by bmStatuses", async () => {
    const { items, total } = await repo.listTickets({ bmStatuses: ["abandoned"] });
    expect(items.map((r) => r.identifier)).toEqual(["DEN-3003"]);
    expect(total).toBe(1);
  });

  it("supports multi-value status filtering", async () => {
    const { items } = await repo.listTickets({ bmStatuses: ["completed", "abandoned"] });
    expect(items.map((r) => r.identifier).sort()).toEqual(["DEN-3001", "DEN-3003"]);
  });

  it("matches the free-text query against identifier, title, description, and branch name", async () => {
    const byIdent = await repo.listTickets({ q: "DEN-3002" });
    expect(byIdent.items.map((r) => r.identifier)).toEqual(["DEN-3002"]);

    const byTitle = await repo.listTickets({ q: "csv" });
    expect(byTitle.items.map((r) => r.identifier)).toEqual(["DEN-3004"]);

    const byBranch = await repo.listTickets({ q: "config-v3" });
    expect(byBranch.items.map((r) => r.identifier)).toEqual(["DEN-3003"]);

    const byDescription = await repo.listTickets({ q: "per-key" });
    expect(byDescription.items.map((r) => r.identifier)).toEqual(["DEN-3001"]);
  });

  it("filters by label", async () => {
    const ingest = await repo.listTickets({ labels: ["module:ingest"] });
    expect(ingest.items.map((r) => r.identifier)).toEqual(["DEN-3003"]);
    const bff = await repo.listTickets({ labels: ["module:bff"] });
    expect(bff.items.map((r) => r.identifier).sort()).toEqual(["DEN-3001", "DEN-3004"]);
  });

  it("filters by latest-run worker and stop reason", async () => {
    const worker2 = await repo.listTickets({ workerIds: ["wk_2"] });
    expect(worker2.items.map((r) => r.identifier)).toEqual(["DEN-3002"]);

    const timedOut = await repo.listTickets({ stopReasons: ["timeout"] });
    expect(timedOut.items.map((r) => r.identifier)).toEqual(["DEN-3003"]);
  });

  it("filters by createdFrom/createdTo and rejects empty windows by returning nothing", async () => {
    const recent = await repo.listTickets({ createdFrom: new Date("2026-06-09T08:30:00Z") });
    expect(recent.items.map((r) => r.identifier).sort()).toEqual(["DEN-3004"]);

    const window = await repo.listTickets({
      createdFrom: new Date("2026-06-09T07:00:00Z"),
      createdTo: new Date("2026-06-09T08:30:00Z"),
    });
    expect(window.items.map((r) => r.identifier).sort()).toEqual(["DEN-3001", "DEN-3002"]);
  });

  it("paginates with total preserved across pages", async () => {
    const first = await repo.listTickets({ pageSize: 2, page: 1 });
    expect(first.items.length).toBe(2);
    expect(first.total).toBe(4);
    const second = await repo.listTickets({ pageSize: 2, page: 2 });
    expect(second.items.length).toBe(2);
    expect(second.total).toBe(4);
    const overlap = new Set([...first.items, ...second.items].map((r) => r.id));
    expect(overlap.size).toBe(4);
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
