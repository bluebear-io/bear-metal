import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import { createFactoryRouter, FACTORY_SIGNATURE_HEADER, FACTORY_TIMESTAMP_HEADER } from "./factory-api.js";
import { signRequest } from "./request-signature.js";

const secret = "factory-secret";

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "attempt-1:1",
    runId: "run-1",
    owner: "owner@example.com",
    role: "developer",
    grants: ["repo.read", "file.edit", "git.push"],
    repository: "bluebear-io/blueden",
    baseSha: "a".repeat(40),
    scratchBranch: "wf/run/run-1/implement",
    instruction: "Fix the bug",
    outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
    deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
    maxTokens: 100_000,
    ...overrides,
  };
}

describe("factory task API", () => {
  let db: SqlDbClient;
  let app: express.Express;
  const wake = vi.fn();

  const signed = (method: "get" | "post", path: string, body?: unknown, key = secret) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const call = request(app)[method](`/factory${path}`)
      .set(FACTORY_TIMESTAMP_HEADER, timestamp)
      .set(FACTORY_SIGNATURE_HEADER, signRequest(text, timestamp, key));
    return body === undefined ? call : call.set("Content-Type", "application/json").send(text);
  };

  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    wake.mockReset();
    app = express();
    app.use("/factory", createFactoryRouter({
      db, signingSecret: secret, capabilities: ["repo.read", "git.push"], logger: createLogger({ name: "test", level: "silent" }), wake,
    }));
    app.use(express.json());
  });
  afterEach(async () => { await db.close(); });

  it("creates a factory task without a ticket that the ticket scheduler never picks up", async () => {
    const created = await signed("post", "/tasks", taskBody());
    expect(created.status).toBe(202);
    expect(created.body).toEqual({ id: expect.any(String), status: "queued" });
    expect(wake).toHaveBeenCalledTimes(1);
    const fetched = await signed("get", `/tasks/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id: created.body.id, status: "queued", result: null });
    expect(await db.acquireNext("worker-1")).toBeNull();
    expect((await db.getFactoryTask(created.body.id))?.request.owner).toBe("owner@example.com");
  });

  it("rejects a bad signature, a stale timestamp and an unsigned GET", async () => {
    expect((await signed("post", "/tasks", taskBody(), "wrong-secret")).status).toBe(401);
    const text = JSON.stringify(taskBody());
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await request(app).post("/factory/tasks").set("Content-Type", "application/json")
      .set(FACTORY_TIMESTAMP_HEADER, old).set(FACTORY_SIGNATURE_HEADER, signRequest(text, old, secret)).send(text)).status).toBe(401);
    expect((await request(app).get("/factory/capabilities")).status).toBe(401);
  });

  it("refuses a task without an owner, with an unknown field, or with a past deadline", async () => {
    const { owner: _owner, ...withoutOwner } = taskBody();
    expect((await signed("post", "/tasks", withoutOwner)).body).toEqual({ error: "owner is required" });
    expect((await signed("post", "/tasks", taskBody({ pushRef: "main" }))).body).toEqual({ error: "unknown field pushRef" });
    expect((await signed("post", "/tasks", taskBody({ deadline: new Date(Date.now() - 1000).toISOString() }))).status).toBe(400);
    expect((await signed("post", "/tasks", taskBody({ scratchBranch: "main" }))).body).toEqual({ error: "scratchBranch is invalid" });
  });

  it("returns the same task for a repeated key and body and rejects the key with another body", async () => {
    const first = await signed("post", "/tasks", taskBody());
    const reordered = Object.fromEntries(Object.entries(taskBody({ deadline: (await db.getFactoryTask(first.body.id))!.request.deadline })).reverse());
    const repeat = await signed("post", "/tasks", reordered);
    expect(repeat.status).toBe(202);
    expect(repeat.body.id).toBe(first.body.id);
    expect(wake).toHaveBeenCalledTimes(1);
    const changed = await signed("post", "/tasks", taskBody({ instruction: "Something else" }));
    expect(changed.status).toBe(409);
  });

  it("supersedes the older task of an attempt and rejects a stale fencing token", async () => {
    const older = await signed("post", "/tasks", taskBody());
    const newer = await signed("post", "/tasks", taskBody({ idempotencyKey: "attempt-1:2" }));
    expect(newer.status).toBe(202);
    expect((await db.getFactoryTask(older.body.id))?.status).toBe("superseded");
    expect((await signed("post", "/tasks", taskBody({ idempotencyKey: "attempt-1:1", instruction: "late" }))).status).toBe(409);
    expect((await db.getFactoryTask(newer.body.id))?.status).toBe("queued");
  });

  it("cancels a task, keeps an ended task's outcome, and returns 404 for an unknown task", async () => {
    const created = await signed("post", "/tasks", taskBody());
    const canceled = await signed("post", `/tasks/${created.body.id}/cancel`);
    expect(canceled.body).toMatchObject({ status: "canceled", error: "Canceled by the factory" });
    expect(await db.claimFactoryTask()).toBeNull();
    expect((await signed("post", `/tasks/${created.body.id}/cancel`)).body.status).toBe("canceled");
    expect((await signed("post", "/tasks/unknown/cancel")).status).toBe(404);
    expect((await signed("get", "/tasks/unknown")).status).toBe(404);
  });

  it("publishes the supported capabilities", async () => {
    expect((await signed("get", "/capabilities")).body).toEqual({ capabilities: ["repo.read", "git.push"] });
  });
});
