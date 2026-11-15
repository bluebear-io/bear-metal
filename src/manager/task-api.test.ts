import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import { signRequest } from "./request-signature.js";
import { createTaskApiRouter, TASK_API_SIGNATURE_HEADER, TASK_API_TIMESTAMP_HEADER, type TicketDelegation } from "./task-api.js";

const secret = "task-api-secret";
const profile = {
  id: "developer", name: "Developer", instructions: "Write code.", toolCeiling: ["repo.read", "file.edit"], shell: true, customerData: false,
  labels: { kind: "feature" },
};

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "request-1",
    profile,
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

  let delegated: { id: string } | null;
  let tickets: TicketDelegation & { [K in keyof TicketDelegation]: ReturnType<typeof vi.fn> };
  const mount = (withTickets: boolean) => {
    app = express();
    app.use("/task-api", createTaskApiRouter({
      db, signingSecret: secret, logger: createLogger({ name: "test", level: "silent" }), wake, ...(withTickets ? { tickets } : {}),
    }));
    app.use(express.json());
  };

  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    wake.mockReset();
    delegated = null;
    tickets = {
      getAgentId: vi.fn(async () => "agent"),
      getTicket: vi.fn(async (id: string) => {
        if (id !== "DEN-1") throw new Error(`Linear issue ${id} not found`);
        return { id: "issue-1", delegate: delegated };
      }),
      findUserIdByEmail: vi.fn(async (email: string) => {
        if (email !== "owner@example.com") throw new Error(`Expected one Linear user for ${email}, got 0`);
        return "user-1";
      }),
      assignAndDelegate: vi.fn(async () => { delegated = { id: "agent" }; }),
      handBack: vi.fn(async () => { delegated = null; }),
    };
    mount(true);
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
    expect((await db.getApiTask(created.body.id))?.request).toMatchObject({ owner: "owner@example.com", profile });
    expect(tickets.assignAndDelegate).not.toHaveBeenCalled();
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
    expect((await signed("post", "/tasks", withoutProfile)).body).toEqual({ error: "profile must be a JSON object" });
    expect((await signed("post", "/tasks", taskBody({ profile: "developer" }))).body).toEqual({ error: "profile must be a JSON object" });
    const { customerData: _customerData, ...withoutCustomerData } = profile;
    expect((await signed("post", "/tasks", taskBody({ profile: withoutCustomerData }))).body).toEqual({ error: "profile.customerData must be a boolean" });
    expect((await signed("post", "/tasks", taskBody({ profile: { ...profile, toolCeiling: "repo.read" } }))).body)
      .toEqual({ error: "profile.toolCeiling must be an array of strings" });
    expect((await signed("post", "/tasks", taskBody({ profile: { ...profile, id: "Bad Id" } }))).body).toEqual({ error: "profile.id is invalid" });
    expect((await signed("post", "/tasks", taskBody({ profile: { ...profile, model: "x" } }))).body).toEqual({ error: "unknown field profile.model" });
    const { repository: _repository, ...withoutRepository } = taskBody();
    expect((await signed("post", "/tasks", withoutRepository)).body).toEqual({ error: "repository is required" });
    expect((await signed("post", "/tasks", taskBody({ branch: "main" }))).body).toEqual({ error: "unknown field branch" });
    for (const owner of ["owner", "a@@b.com", "a b@c.com", `${"!.".repeat(5_000)}@x.com`]) {
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

  const codingBody = (overrides: Record<string, unknown> = {}) => {
    const { repository: _repository, outputSchema: _outputSchema, ...body } = taskBody({ ticketId: "DEN-1", inputs: { area: "billing" }, ...overrides });
    return body;
  };

  it("assigns a coding task's ticket to its owner and delegates it, once per idempotency key", async () => {
    const body = codingBody();
    const created = await signed("post", "/tasks", body);
    expect(created.status).toBe(202);
    expect(created.body).toEqual({ id: expect.any(String), status: "running" });
    expect(tickets.assignAndDelegate).toHaveBeenCalledExactlyOnceWith("issue-1", "user-1");
    expect(wake).not.toHaveBeenCalled();
    expect(await db.getApiTask(created.body.id)).toMatchObject({ ticketIssueId: "issue-1", request: { ticketId: "DEN-1", profile } });
    expect(await db.claimApiTask()).toBeNull();
    expect((await db.getTicketApiTask("issue-1"))?.id).toBe(created.body.id);

    const repeat = await signed("post", "/tasks", body);
    expect(repeat.body).toEqual({ id: created.body.id, status: "running" });
    expect(tickets.assignAndDelegate).toHaveBeenCalledTimes(1);
    expect((await signed("post", "/tasks", codingBody({ instruction: "Other" }))).status).toBe(409);
  });

  it("refuses a coding task whose ticket Bear Metal already has, cannot read, or whose owner Linear does not know", async () => {
    delegated = { id: "agent" };
    expect(await signed("post", "/tasks", codingBody())).toMatchObject({ status: 409, body: { error: "Ticket DEN-1 is already delegated to Bear Metal" } });
    delegated = null;
    expect(await signed("post", "/tasks", codingBody({ idempotencyKey: "owner", owner: "stranger@example.com" })))
      .toMatchObject({ status: 400, body: { error: "Cannot find the owner in Linear: Expected one Linear user for stranger@example.com, got 0" } });
    await db.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "issue-1" });
    expect((await signed("post", "/tasks", codingBody())).status).toBe(409);
    expect(await signed("post", "/tasks", codingBody({ idempotencyKey: "other", ticketId: "DEN-2" })))
      .toMatchObject({ status: 400, body: { error: "Cannot read ticket DEN-2: Linear issue DEN-2 not found" } });
    expect(tickets.assignAndDelegate).not.toHaveBeenCalled();
    expect(await signed("post", "/tasks", { ...codingBody(), repository: "acme/widgets" }))
      .toMatchObject({ status: 400, body: { error: "repository is not allowed with ticketId; the ticket's workspace is used" } });
    expect((await signed("post", "/tasks", { ...codingBody(), outputSchema: { type: "object" } })).body)
      .toEqual({ error: "outputSchema is not allowed with ticketId; a coding task ends with a pull request" });
  });

  it("fails a coding task whose ticket Linear does not delegate, and refuses coding tasks without the scheduler", async () => {
    tickets.assignAndDelegate.mockRejectedValueOnce(new Error("Linear is down"));
    const failed = await signed("post", "/tasks", codingBody());
    expect(failed).toMatchObject({ status: 502, body: { error: "Cannot delegate ticket DEN-1: Linear is down" } });
    const stored = await db.getApiTaskByKey("request-1");
    expect(stored).toMatchObject({ status: "failed", error: "Cannot delegate ticket DEN-1: Linear is down" });
    expect(await db.getTicketApiTask("issue-1")).toBeNull();

    mount(false);
    expect(await signed("post", "/tasks", codingBody({ idempotencyKey: "no-scheduler" })))
      .toMatchObject({ status: 400, body: { error: "Coding tasks need the Linear scheduler, which is off" } });
  });

  it("cancels a coding task by handing its ticket back and stopping its run", async () => {
    const created = await signed("post", "/tasks", codingBody());
    const run = await db.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "issue-1" });
    await db.acquireNext("worker-1");
    await db.upsertRunStarted(run.id, "worker-1", new Date().toISOString());

    const canceled = await signed("post", `/tasks/${created.body.id}/cancel`);
    expect(canceled.body).toMatchObject({ status: "canceled" });
    expect(tickets.handBack).toHaveBeenCalledExactlyOnceWith("issue-1");
    expect(await db.getTrackedSlot("issue-1")).toBeNull();
    expect(await db.heartbeat(run.id, "worker-1")).toBe(false);
    expect(await db.getTicketApiTask("issue-1")).toBeNull();

    await signed("post", `/tasks/${created.body.id}/cancel`);
    expect(tickets.handBack).toHaveBeenCalledTimes(1);
  });
});
