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
  it("lists tickets newest-first with summaries and pagination metadata", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets.length).toBe(4);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(50);
    expect(res.body.tickets[0].identifier).toBe("DEN-3004"); // newest createdAt
    expect(res.body.tickets.find((t: { identifier: string }) => t.identifier === "DEN-3002").latestRun).toMatchObject({
      id: "run_3",
      attemptNumber: 2,
      status: "running",
      trigger: "ci_failure",
      workerId: "wk_2",
    });
    const completed = res.body.tickets.find((t: { identifier: string }) => t.identifier === "DEN-3001");
    expect(completed.latestWorkerName).toBe("worker-1");
  });

  it("filters by status (legacy single param)", async () => {
    const res = await request(app).get("/api/tickets?status=abandoned");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);
    expect(res.body.total).toBe(1);
  });

  it("filters by multi-value statuses", async () => {
    const res = await request(app).get("/api/tickets?statuses=completed,abandoned");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier).sort()).toEqual(["DEN-3001", "DEN-3003"]);
  });

  it("rejects an invalid status filter (fail-fast, not silently ignored)", async () => {
    const res = await request(app).get("/api/tickets?status=bogus");
    expect(res.status).toBe(400);
  });

  it("supports free-text search", async () => {
    const res = await request(app).get("/api/tickets?q=csv");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3004"]);
  });

  it("filters by worker, label, and stop reason", async () => {
    const byWorker = await request(app).get("/api/tickets?workerId=wk_2");
    expect(byWorker.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3002"]);

    const byLabel = await request(app).get("/api/tickets?label=module:ingest");
    expect(byLabel.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);

    const byStop = await request(app).get("/api/tickets?stopReason=timeout");
    expect(byStop.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);
  });

  it("rejects an invalid stop reason", async () => {
    const res = await request(app).get("/api/tickets?stopReason=bogus");
    expect(res.status).toBe(400);
  });

  it("paginates with total preserved across pages", async () => {
    const first = await request(app).get("/api/tickets?pageSize=2&page=1");
    expect(first.body.tickets.length).toBe(2);
    expect(first.body.total).toBe(4);
    const second = await request(app).get("/api/tickets?pageSize=2&page=2");
    expect(second.body.tickets.length).toBe(2);
    expect(second.body.total).toBe(4);
  });

  it("rejects malformed pagination + date params", async () => {
    expect((await request(app).get("/api/tickets?page=0")).status).toBe(400);
    expect((await request(app).get("/api/tickets?pageSize=0")).status).toBe(400);
    expect((await request(app).get("/api/tickets?createdFrom=not-a-date")).status).toBe(400);
    expect((await request(app).get("/api/tickets?createdFrom=2026-06-09T09:00:00Z&createdTo=2026-06-09T08:00:00Z")).status).toBe(400);
  });
});

describe("GET /api/tickets/filters", () => {
  it("returns the dropdown choices for the archive filter bar", async () => {
    const res = await request(app).get("/api/tickets/filters");
    expect(res.status).toBe(200);
    expect(res.body.bmStatuses).toContain("completed");
    expect(res.body.bmStatuses).toContain("abandoned");
    expect(res.body.stopReasons).toEqual(expect.arrayContaining(["completed", "timeout"]));
    expect(res.body.labels).toEqual(expect.arrayContaining(["bear-metal", "module:bff", "module:ingest"]));
    expect(res.body.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "wk_1", name: "worker-1" }),
        expect.objectContaining({ id: "wk_2", name: "worker-2" }),
      ]),
    );
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
  it("returns the worker timeline with an ISO window and a row per worker", async () => {
    const res = await request(app).get("/api/workers/timeline");
    expect(res.status).toBe(200);
    expect(res.body.window.from).toMatch(/T.*Z$/);
    expect(res.body.window.to).toMatch(/T.*Z$/);
    expect(res.body.workers.length).toBe(3);
    for (const w of res.body.workers) {
      expect(typeof w.workerId).toBe("string");
      expect(typeof w.workerName).toBe("string");
      expect(Array.isArray(w.spans)).toBe(true);
    }
  });

  it("rejects from >= to", async () => {
    const now = new Date().toISOString();
    const res = await request(app).get(`/api/workers/timeline?from=${encodeURIComponent(now)}&to=${encodeURIComponent(now)}`);
    expect(res.status).toBe(400);
  });

  it("rejects a window larger than the 7-day cap", async () => {
    const to = new Date("2026-06-09T00:00:00Z").toISOString();
    const from = new Date("2026-05-01T00:00:00Z").toISOString();
    const res = await request(app).get(`/api/workers/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
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
