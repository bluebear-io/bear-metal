import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { seedMockData } from "../mock/seed.js";
import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  const sqlite = new Database(":memory:");
  const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
  app = createApp(db);
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/tickets", () => {
  it("lists tickets newest-first with summaries and pagination metadata", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets.length).toBe(4);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(typeof res.body.pageSize).toBe("number");
    expect(res.body.tickets[0].identifier).toBe("DEN-3004"); // newest createdAt
    expect(res.body.tickets.find((t: { identifier: string }) => t.identifier === "DEN-3002").latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });
  });

  it("filters by status (legacy single-value param)", async () => {
    const res = await request(app).get("/api/tickets?status=abandoned");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);
    expect(res.body.total).toBe(1);
  });

  it("filters by multiple bmStatus values", async () => {
    const res = await request(app).get("/api/tickets?bmStatus=completed&bmStatus=abandoned");
    expect(res.status).toBe(200);
    expect(
      res.body.tickets.map((t: { identifier: string }) => t.identifier).sort(),
    ).toEqual(["DEN-3001", "DEN-3003"]);
  });

  it("supports full-text search", async () => {
    const res = await request(app).get("/api/tickets?search=rate%20limiting");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3001"]);
  });

  it("filters by worker, label, stop reason, error signature, and date range", async () => {
    const byWorker = await request(app).get("/api/tickets?workerId=wk_2");
    expect(byWorker.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3002"]);

    const byLabel = await request(app).get("/api/tickets?label=module%3Aingest");
    expect(byLabel.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);

    const byReason = await request(app).get("/api/tickets?stopReason=timeout");
    expect(byReason.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);

    const byError = await request(app).get("/api/tickets?errorSignature=wall%20clock");
    expect(byError.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);

    const byDate = await request(app).get("/api/tickets?createdAfter=2026-06-09T08:30:00Z");
    expect(byDate.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3004"]);
  });

  it("paginates", async () => {
    const page1 = await request(app).get("/api/tickets?page=1&pageSize=2");
    expect(page1.status).toBe(200);
    expect(page1.body.tickets.length).toBe(2);
    expect(page1.body.total).toBe(4);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    const page2 = await request(app).get("/api/tickets?page=2&pageSize=2");
    expect(page2.body.tickets.length).toBe(2);
    const ids1 = page1.body.tickets.map((t: { id: string }) => t.id);
    const ids2 = page2.body.tickets.map((t: { id: string }) => t.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it("rejects an invalid status filter (fail-fast, not silently ignored)", async () => {
    const res = await request(app).get("/api/tickets?status=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid stopReason filter", async () => {
    const res = await request(app).get("/api/tickets?stopReason=bogus");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid date filter", async () => {
    const res = await request(app).get("/api/tickets?createdAfter=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects pageSize over the cap", async () => {
    const res = await request(app).get("/api/tickets?pageSize=99999");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tickets/filters", () => {
  it("returns dropdown sources", async () => {
    const res = await request(app).get("/api/tickets/filters");
    expect(res.status).toBe(200);
    expect(res.body.bmStatuses).toContain("completed");
    expect(res.body.bmStatuses).toContain("abandoned");
    expect(res.body.stopReasons).toEqual(["completed", "timeout"]);
    expect(res.body.labels).toEqual(["bear-metal", "module:bff", "module:ingest"]);
    expect(typeof res.body.defaultPageSize).toBe("number");
    expect(typeof res.body.maxPageSize).toBe("number");
  });
});

describe("GET /api/tickets/:id", () => {
  it("returns full detail", async () => {
    const res = await request(app).get("/api/tickets/lin_2");
    expect(res.status).toBe(200);
    expect(res.body.ticket.identifier).toBe("DEN-3002");
    expect(res.body.runs.length).toBe(2);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("404s for an unknown ticket", async () => {
    const res = await request(app).get("/api/tickets/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/workers", () => {
  it("lists workers with current ticket", async () => {
    const res = await request(app).get("/api/workers");
    expect(res.status).toBe(200);
    expect(res.body.workers.length).toBe(3);
    const busy = res.body.workers.find((w: { id: string }) => w.id === "wk_1");
    expect(busy.currentTicketIdentifier).toBe("DEN-3004");
    expect(busy.currentRun).toMatchObject({
      id: "run_in_1",
      ticketIdentifier: "DEN-3004",
      ticketTitle: "Add CSV export to reports page",
      status: "running",
    });
    expect(busy.currentTicketTitle).toBe("Add CSV export to reports page");
    expect(busy.currentRun.runtimeMs).toEqual(expect.any(Number));
    expect(busy.currentRun.startedAt).toMatch(/^2026-06-09T08:55:00/);
    expect(busy.currentRun.endedAt).toBeNull();
    expect(busy).toMatchObject({
      isDead: false,
      isTimedOut: expect.any(Boolean),
      isHeartbeatStale: expect.any(Boolean),
      heartbeatAgeMs: expect.any(Number),
    });
  });
});
