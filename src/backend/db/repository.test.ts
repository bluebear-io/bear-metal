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
