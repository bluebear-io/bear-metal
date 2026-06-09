import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers } from "./repository.js";

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
    const rows = listWorkers(db);
    expect(rows.length).toBe(3);
    const busy = rows.find((w) => w.id === "wk_1")!;
    expect(busy.status).toBe("busy");
    expect(busy.currentTicketIdentifier).toBe("DEN-3004");
    expect(rows.some((w) => w.status === "dead")).toBe(true);
  });
});
