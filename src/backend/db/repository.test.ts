import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers, listStopReasons, listTicketLabels } from "./repository.js";

let db: BetterSQLite3Database<typeof schema>;
beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
});

describe("listTickets", () => {
  it("returns all tickets newest-first with attempt + latest PR/CI summary", () => {
    const { tickets, total, page, pageSize } = listTickets(db);
    expect(tickets.length).toBe(4);
    expect(total).toBe(4);
    expect(page).toBe(1);
    expect(pageSize).toBeGreaterThanOrEqual(4);
    expect(tickets[0]!.createdAt >= tickets[1]!.createdAt).toBe(true);
    const createdAts = tickets.map((r) => r.createdAt.getTime());
    expect(createdAts).toEqual([...createdAts].sort((a, b) => b - a));
    const completed = tickets.find((r) => r.identifier === "DEN-3001")!;
    expect(completed.bmStatus).toBe("completed");
    expect(completed.latestPr?.number).toBe(1500);
    expect(completed.latestCiStatus).toBe("passed");
    expect(completed.attemptCount).toBe(1);
  });

  it("includes the latest run summary for each ticket", () => {
    const { tickets } = listTickets(db);
    const retry = tickets.find((r) => r.identifier === "DEN-3002")!;
    expect(retry.latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });

    const abandoned = tickets.find((r) => r.identifier === "DEN-3003")!;
    expect(abandoned.latestRun?.status).toBe("timed_out");
  });

  it("filters by bmStatus", () => {
    const { tickets, total } = listTickets(db, { bmStatuses: ["abandoned"] });
    expect(tickets.map((r) => r.identifier)).toEqual(["DEN-3003"]);
    expect(total).toBe(1);
  });

  it("full-text search matches identifier, title, description, and branch name", () => {
    expect(listTickets(db, { search: "den-3002" }).tickets.map((t) => t.identifier)).toEqual(["DEN-3002"]);
    expect(listTickets(db, { search: "rate limiting" }).tickets.map((t) => t.identifier)).toEqual(["DEN-3001"]);
    expect(listTickets(db, { search: "throttle" }).tickets.map((t) => t.identifier)).toEqual(["DEN-3001"]);
    expect(listTickets(db, { search: "den-3004-csv-export" }).tickets.map((t) => t.identifier)).toEqual(["DEN-3004"]);
    expect(listTickets(db, { search: "nothing-matches-this" }).tickets).toEqual([]);
  });

  it("filters by worker id via any run that touched the ticket", () => {
    const { tickets } = listTickets(db, { workerIds: ["wk_2"] });
    expect(tickets.map((t) => t.identifier).sort()).toEqual(["DEN-3002"]);
  });

  it("filters by label requiring all of the requested labels", () => {
    expect(
      listTickets(db, { labels: ["module:bff"] }).tickets.map((t) => t.identifier).sort(),
    ).toEqual(["DEN-3001", "DEN-3004"]);
    expect(
      listTickets(db, { labels: ["module:bff", "bear-metal"] }).tickets.map((t) => t.identifier).sort(),
    ).toEqual(["DEN-3001", "DEN-3004"]);
    expect(listTickets(db, { labels: ["module:ingest"] }).tickets.map((t) => t.identifier)).toEqual(["DEN-3003"]);
  });

  it("filters by stopReason on runs", () => {
    expect(listTickets(db, { stopReasons: ["timeout"] }).tickets.map((t) => t.identifier)).toEqual(["DEN-3003"]);
    expect(listTickets(db, { stopReasons: ["completed"] }).tickets.map((t) => t.identifier).sort()).toEqual(["DEN-3001", "DEN-3002"]);
  });

  it("filters by error signature substring", () => {
    expect(listTickets(db, { errorSignature: "wall clock" }).tickets.map((t) => t.identifier)).toEqual(["DEN-3003"]);
    expect(listTickets(db, { errorSignature: "no-such-error" }).tickets).toEqual([]);
  });

  it("filters by createdAt range", () => {
    const { tickets } = listTickets(db, { createdAfter: new Date("2026-06-09T08:30:00Z") });
    expect(tickets.map((t) => t.identifier).sort()).toEqual(["DEN-3004"]);
  });

  it("paginates and reports the total match count", () => {
    const first = listTickets(db, { page: 1, pageSize: 2 });
    expect(first.tickets.length).toBe(2);
    expect(first.total).toBe(4);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(2);
    const second = listTickets(db, { page: 2, pageSize: 2 });
    expect(second.tickets.length).toBe(2);
    const firstIds = first.tickets.map((t) => t.id);
    const secondIds = second.tickets.map((t) => t.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });
});

describe("listStopReasons / listTicketLabels", () => {
  it("returns distinct stop reasons present in runs", () => {
    expect(listStopReasons(db)).toEqual(["completed", "timeout"]);
  });

  it("returns distinct labels from labelsJson", () => {
    expect(listTicketLabels(db)).toEqual(["bear-metal", "module:bff", "module:ingest"]);
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
