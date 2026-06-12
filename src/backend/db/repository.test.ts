import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { createRepository, type Repository } from "./repository.js";

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
