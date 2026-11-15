import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import { signRequest } from "./request-signature.js";
import { createTaskApiRouter, TASK_API_SIGNATURE_HEADER, TASK_API_TIMESTAMP_HEADER } from "./task-api.js";

const secret = "task-api-secret";

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "request-1",
    profile: "developer",
    owner: "owner@example.com",
    repository: "acme/widgets",
    instruction: "Fix the bug",
    outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    maxTokens: 100_000,
    ...overrides,
  };
}

describe("task API", () => {
  let db: SqlDbClient;
  let app: express.Express;
  const wake = vi.fn();

  const signed = (method: "get" | "post", path: string, body?: unknown, key = secret) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const call = request(app)[method](`/task-api${path}`)
      .set(TASK_API_TIMESTAMP_HEADER, timestamp)
      .set(TASK_API_SIGNATURE_HEADER, signRequest(text, timestamp, key));
    return body === undefined ? call : call.set("Content-Type", "application/json").send(text);
  };

  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    wake.mockReset();
    app = express();
    app.use("/task-api", createTaskApiRouter({ db, signingSecret: secret, logger: createLogger({ name: "test", level: "silent" }), wake }));
    app.use(express.json());
  });
  afterEach(async () => { await db.close(); });

  it("creates a task without a ticket that the ticket scheduler never picks up", async () => {
    const created = await signed("post", "/tasks", taskBody());
    expect(created.status).toBe(202);
    expect(created.body).toEqual({ id: expect.any(String), status: "queued" });
    expect(wake).toHaveBeenCalledTimes(1);
    const fetched = await signed("get", `/tasks/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id: created.body.id, status: "queued", result: null });
    expect(await db.acquireNext("worker-1")).toBeNull();
    expect((await db.getApiTask(created.body.id))?.request).toMatchObject({ owner: "owner@example.com", profile: "developer" });
  });

  it("rejects a bad signature, a stale timestamp and an unsigned GET", async () => {
    expect((await signed("post", "/tasks", taskBody(), "wrong-secret")).status).toBe(401);
    const text = JSON.stringify(taskBody());
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await request(app).post("/task-api/tasks").set("Content-Type", "application/json")
      .set(TASK_API_TIMESTAMP_HEADER, old).set(TASK_API_SIGNATURE_HEADER, signRequest(text, old, secret)).send(text)).status).toBe(401);
    expect((await request(app).get("/task-api/tasks/unknown")).status).toBe(401);
  });

  it("refuses a task without an owner or profile, with an unknown field, a bad owner or a past deadline", async () => {
    const { owner: _owner, ...withoutOwner } = taskBody();
    expect((await signed("post", "/tasks", withoutOwner)).body).toEqual({ error: "owner is required" });
    const { profile: _profile, ...withoutProfile } = taskBody();
    expect((await signed("post", "/tasks", withoutProfile)).body).toEqual({ error: "profile is required" });
    expect((await signed("post", "/tasks", taskBody({ branch: "main" }))).body).toEqual({ error: "unknown field branch" });
    for (const owner of ["owner", "a@b", "a@@b.com", `${"!.".repeat(5_000)}@x.com`]) {
      expect((await signed("post", "/tasks", taskBody({ owner }))).body).toEqual({ error: "owner is invalid" });
    }
    expect((await signed("post", "/tasks", taskBody({ deadline: new Date(Date.now() - 1000).toISOString() }))).status).toBe(400);
  });

  it("returns the same task for a repeated key and body and rejects the key with another body", async () => {
    const first = await signed("post", "/tasks", taskBody());
    const reordered = Object.fromEntries(Object.entries(taskBody({ deadline: (await db.getApiTask(first.body.id))!.request.deadline })).reverse());
    const repeat = await signed("post", "/tasks", reordered);
    expect(repeat.status).toBe(202);
    expect(repeat.body.id).toBe(first.body.id);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await signed("post", "/tasks", taskBody({ instruction: "Something else" }))).status).toBe(409);
  });

  it("cancels a task, keeps an ended task's outcome, and returns 404 for an unknown task", async () => {
    const created = await signed("post", "/tasks", taskBody());
    const canceled = await signed("post", `/tasks/${created.body.id}/cancel`);
    expect(canceled.body).toMatchObject({ status: "canceled", error: "Canceled through the task API" });
    expect(await db.claimApiTask()).toBeNull();
    expect((await signed("post", `/tasks/${created.body.id}/cancel`)).body.status).toBe("canceled");
    expect((await signed("post", "/tasks/unknown/cancel")).status).toBe(404);
    expect((await signed("get", "/tasks/unknown")).status).toBe(404);
  });
});
