import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { createApp } from "../app.js";

const TOKEN = "secret-123";
let app: ReturnType<typeof createApp>;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  app = createApp(db, { ingestToken: TOKEN });
});

const ticketBody = {
  id: "lin_x", identifier: "DEN-X", title: "t", description: null, url: "u", branchName: "b",
  linearStatusName: "Todo", linearStatusType: "unstarted", labels: ["bear-metal"],
  bmStatus: "discovered", attemptCount: 0, maxAttempts: 5,
  createdAt: 1000, updatedAt: 1000, completedAt: null,
};

describe("write auth", () => {
  it("rejects a missing token with 401", async () => {
    const res = await request(app).put("/api/tickets/lin_x").send(ticketBody);
    expect(res.status).toBe(401);
  });
  it("rejects a wrong token with 401", async () => {
    const res = await request(app).put("/api/tickets/lin_x").set("authorization", "Bearer nope").send(ticketBody);
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/tickets/:id", () => {
  it("upserts and is then visible to the read API", async () => {
    const put = await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    expect(put.status).toBe(204);
    const get = await request(app).get("/api/tickets/lin_x");
    expect(get.status).toBe(200);
    expect(get.body.ticket.bmStatus).toBe("discovered");
  });
  it("rejects an invalid bmStatus with 400", async () => {
    const res = await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send({ ...ticketBody, bmStatus: "bogus" });
    expect(res.status).toBe(400);
  });
  it("rejects a mismatched id (path vs body) with 400", async () => {
    const res = await request(app).put("/api/tickets/other").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/ci-runs/:id/checks", () => {
  async function seedTicketRunPrCi() {
    await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    await request(app).put("/api/runs/run_1").set("authorization", `Bearer ${TOKEN}`).send({
      id: "run_1", ticketId: "lin_x", attemptNumber: 1, workerId: null, trigger: "new",
      status: "running", contextJson: null, startedAt: 1, endedAt: null, stopReason: null,
      error: null, promptTokens: null, completionTokens: null, modelName: null, provider: null,
      createdAt: 1,
    });
    await request(app).put("/api/pull-requests/pr_1").set("authorization", `Bearer ${TOKEN}`).send({
      id: "pr_1", ticketId: "lin_x", number: 1, title: "x", headRef: "h", state: "open",
      draft: false, merged: false, url: "u", lastRunId: "run_1", createdAt: 1, updatedAt: 1,
    });
    await request(app).put("/api/ci-runs/ci_1").set("authorization", `Bearer ${TOKEN}`).send({
      id: "ci_1", ticketId: "lin_x", runId: "run_1", prId: "pr_1", status: "failed",
      url: null, summary: null, createdAt: 1, completedAt: null,
    });
  }

  it("replaces the failing checks attached to a CI run and surfaces them on the read API", async () => {
    await seedTicketRunPrCi();
    const res = await request(app).put("/api/ci-runs/ci_1/checks").set("authorization", `Bearer ${TOKEN}`).send({
      checks: [
        { id: "chk_a", source: "check_run", externalId: "99", name: "ESLint", conclusion: "failure", detailsUrl: null, summary: "1 problem", annotationsJson: "[]", createdAt: 2 },
      ],
    });
    expect(res.status).toBe(204);
    const detail = await request(app).get("/api/tickets/lin_x");
    expect(detail.body.ciRuns[0].checks).toHaveLength(1);
    expect(detail.body.ciRuns[0].checks[0]).toMatchObject({ name: "ESLint", conclusion: "failure" });

    // Replacing with a new set must drop the previous rows.
    await request(app).put("/api/ci-runs/ci_1/checks").set("authorization", `Bearer ${TOKEN}`).send({
      checks: [
        { id: "chk_b", source: "status", externalId: "jenkins", name: "jenkins", conclusion: "failure", detailsUrl: null, summary: null, annotationsJson: "[]", createdAt: 3 },
      ],
    });
    const after = await request(app).get("/api/tickets/lin_x");
    expect(after.body.ciRuns[0].checks.map((c: { id: string }) => c.id)).toEqual(["chk_b"]);
  });

  it("rejects a non-array payload with 400", async () => {
    await seedTicketRunPrCi();
    const res = await request(app).put("/api/ci-runs/ci_1/checks").set("authorization", `Bearer ${TOKEN}`).send({ checks: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/pull-requests/:id/review-threads", () => {
  async function seedTicketAndPr() {
    await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    await request(app).put("/api/pull-requests/pr_1").set("authorization", `Bearer ${TOKEN}`).send({
      id: "pr_1", ticketId: "lin_x", number: 1, title: "x", headRef: "h", state: "open",
      draft: false, merged: false, url: "u", lastRunId: null, createdAt: 1, updatedAt: 1,
    });
  }

  it("replaces review threads on a PR and surfaces them on the read API", async () => {
    await seedTicketAndPr();
    const res = await request(app).put("/api/pull-requests/pr_1/review-threads").set("authorization", `Bearer ${TOKEN}`).send({
      threads: [
        { id: "t1", path: "f.ts", line: 1, isResolved: false, commentsJson: "[]", createdAt: 1, updatedAt: 1 },
        { id: "t2", path: null, line: null, isResolved: true, commentsJson: "[]", createdAt: 1, updatedAt: 1 },
      ],
    });
    expect(res.status).toBe(204);
    const detail = await request(app).get("/api/tickets/lin_x");
    expect(detail.body.pullRequests[0].reviewThreads).toHaveLength(2);
    expect(detail.body.pullRequests[0].reviewThreads.find((t: { id: string }) => t.id === "t2").isResolved).toBe(true);
  });

  it("rejects a non-boolean isResolved with 400", async () => {
    await seedTicketAndPr();
    const res = await request(app).put("/api/pull-requests/pr_1/review-threads").set("authorization", `Bearer ${TOKEN}`).send({
      threads: [{ id: "t1", path: null, line: null, isResolved: "yes", commentsJson: "[]", createdAt: 1, updatedAt: 1 }],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/events", () => {
  it("appends an event", async () => {
    await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    const res = await request(app).post("/api/events").set("authorization", `Bearer ${TOKEN}`).send({
      ticketId: "lin_x", runId: null, workerId: null, source: "manager",
      type: "ticket_discovered", summary: "picked up", payloadJson: null, createdAt: 1000,
    });
    expect(res.status).toBe(204);
    const detail = await request(app).get("/api/tickets/lin_x");
    expect(detail.body.events.length).toBe(1);
  });
});
