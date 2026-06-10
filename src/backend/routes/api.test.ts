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
  it("lists tickets newest-first with summaries", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets.length).toBe(4);
    expect(res.body.tickets[0].identifier).toBe("DEN-3004"); // newest createdAt
    expect(res.body.tickets.find((t: { identifier: string }) => t.identifier === "DEN-3002").latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });
  });

  it("filters by status", async () => {
    const res = await request(app).get("/api/tickets?status=abandoned");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);
  });

  it("rejects an invalid status filter (fail-fast, not silently ignored)", async () => {
    const res = await request(app).get("/api/tickets?status=bogus");
    expect(res.status).toBe(400);
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

describe("GET /api/workers/timeline", () => {
  it("returns one row per worker with status intervals across the window", async () => {
    const res = await request(app).get("/api/workers/timeline?hours=72");
    expect(res.status).toBe(200);
    expect(typeof res.body.sinceMs).toBe("number");
    expect(typeof res.body.untilMs).toBe("number");
    expect(res.body.workers.map((w: { name: string }) => w.name).sort()).toEqual(["worker-1", "worker-2", "worker-3"]);
    const w1 = res.body.workers.find((w: { name: string }) => w.name === "worker-1");
    expect(w1.intervals.length).toBeGreaterThan(1); // seeded multiple idle/busy transitions
    expect(w1.intervals.every((iv: { endMs: number; startMs: number }) => iv.endMs > iv.startMs)).toBe(true);
    // Intervals must be sorted and contiguous within the window for each worker.
    for (let i = 1; i < w1.intervals.length; i++) {
      expect(w1.intervals[i].startMs).toBe(w1.intervals[i - 1].endMs);
    }
  });

  it("rejects an out-of-range hours value", async () => {
    const res = await request(app).get("/api/workers/timeline?hours=999");
    expect(res.status).toBe(400);
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
