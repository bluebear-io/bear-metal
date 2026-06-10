import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { seedMockData } from "../mock/seed.js";
import { createApp } from "../app.js";
import { createRepository } from "../db/repository.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  const sqlite = new Database(":memory:");
  const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
  const repo = createRepository({ dialect: "sqlite", db, schema, close: async () => undefined });
  app = createApp(repo);
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

describe("GET /api/summary", () => {
  // The mock seeder lays its events across 2026-06-08 → 2026-06-09. A window centred on that
  // span exercises every block; outside-window queries verify the prior-period symmetry.
  const FROM = "2026-06-08T00:00:00.000Z";
  const TO = "2026-06-10T00:00:00.000Z";

  it("returns the documented shape with all six clusters", async () => {
    const res = await request(app).get("/api/summary").query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    expect(res.body.window).toEqual({ from: FROM, to: TO });
    expect(res.body.prior.from).toMatch(/^2026-06-06T00:00:00/);
    expect(res.body.prior.to).toEqual(FROM);
    expect(res.body).toHaveProperty("throughput");
    expect(res.body).toHaveProperty("health");
    expect(res.body).toHaveProperty("cost");
    expect(res.body).toHaveProperty("time");
    expect(res.body).toHaveProperty("failures");
    expect(res.body).toHaveProperty("shipped");
  });

  it("counts completed/abandoned tickets correctly within the window", async () => {
    const res = await request(app).get("/api/summary").query({ from: FROM, to: TO });
    // The seeder ships exactly one completed (DEN-3001) and one abandoned (DEN-3003).
    expect(res.body.throughput.completed).toBe(1);
    expect(res.body.throughput.abandoned).toBe(1);
    expect(res.body.throughput.discovered).toBeGreaterThanOrEqual(4);
  });

  it("computes a 50% success rate over completed + abandoned tickets", async () => {
    const res = await request(app).get("/api/summary").query({ from: FROM, to: TO });
    expect(res.body.health.successRate).toBeCloseTo(0.5, 5);
  });

  it("buckets shipped tickets by repo with PR + ticket links", async () => {
    const res = await request(app).get("/api/summary").query({ from: FROM, to: TO });
    const byRepo = res.body.shipped.byRepo;
    expect(byRepo.length).toBeGreaterThan(0);
    const bucket = byRepo.find((b: { repo: string }) => b.repo === "bluebear-io/blueden");
    expect(bucket).toBeDefined();
    expect(bucket.count).toBeGreaterThanOrEqual(1);
    expect(bucket.tickets[0]).toMatchObject({
      identifier: expect.any(String),
      title: expect.any(String),
      url: expect.stringContaining("linear.app"),
      prUrl: expect.stringContaining("github.com"),
      prNumber: expect.any(Number),
    });
  });

  it("returns the prior block with identical shape to the current block", async () => {
    const res = await request(app).get("/api/summary").query({ from: FROM, to: TO });
    expect(res.body.throughput.prior).toEqual(expect.objectContaining({
      completed: expect.any(Number),
      abandoned: expect.any(Number),
      discovered: expect.any(Number),
    }));
    expect(res.body.throughput).not.toHaveProperty("inProgress");
    expect(res.body.cost.prior).toEqual(expect.objectContaining({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      estimatedUsd: expect.any(Number),
      byModel: expect.any(Array),
    }));
  });

  it("defaults to a last-7-days window when query params are omitted", async () => {
    const res = await request(app).get("/api/summary");
    expect(res.status).toBe(200);
    const from = new Date(res.body.window.from).getTime();
    const to = new Date(res.body.window.to).getTime();
    expect(to - from).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
  });

  it("rejects from >= to with 400", async () => {
    const res = await request(app).get("/api/summary").query({ from: TO, to: FROM });
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable ISO with 400", async () => {
    const res = await request(app).get("/api/summary").query({ from: "garbage", to: TO });
    expect(res.status).toBe(400);
  });

  it("rejects a window longer than 90 days with 400", async () => {
    const res = await request(app).get("/api/summary").query({
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-06-30T00:00:00.000Z",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/90 days/);
  });
});
