import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { createWriter } from "../db/writer.js";
import { createApp } from "../app.js";

const TOKEN = "secret-123";
let app: ReturnType<typeof createApp>;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  const writer = createWriter({ dialect: "sqlite", db, schema, close: async () => undefined });
  app = createApp(db, { ingestToken: TOKEN, writer });
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
