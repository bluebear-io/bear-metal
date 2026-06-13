import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../shared/index.js";
import type { DbClient, DispatchTaskInput, TaskRecord } from "../db/client.js";

import { ManagerTicketHandler } from "./ticket-handler.js";
import { makeContext } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("ManagerTicketHandler", () => {
  it("enqueues a new task and returns the SQL task id", async () => {
    const db = new FakeDb();
    const handler = new ManagerTicketHandler({ logger, db: db as unknown as DbClient });
    const ctx = makeContext("den-1");

    const outcome = await handler.handle(ctx, "new");

    expect(db.enqueued).toEqual([
      { state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "den-1" },
    ]);
    expect(outcome.status).toBe("pending");
    expect(outcome.taskId).toBe("task-1");
  });

  it("enqueues an iteration task with a compact pull request ref", async () => {
    const db = new FakeDb();
    const handler = new ManagerTicketHandler({ logger, db: db as unknown as DbClient });

    await handler.handle(
      {
        ticket: makeContext("den-2").ticket,
        prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
      },
      "delegated_back",
    );

    expect(db.enqueued).toEqual([
      {
        state: "iteration",
        ticketId: "DEN-2",
        prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
        trigger: "delegated_back",
        ticketIssueId: "den-2",
      },
    ]);
  });

  it("records a dispatched event in the db after enqueue", async () => {
    const db = new FakeDb();
    const handler = new ManagerTicketHandler({ logger, db: db as unknown as DbClient });
    const ctx = makeContext("den-1");

    await handler.handle(ctx, "new");

    // Allow the fire-and-forget void promise to settle.
    await new Promise((r) => setImmediate(r));

    expect(db.recordEventCalls).toHaveLength(1);
    expect(db.recordEventCalls[0]).toEqual(
      expect.objectContaining({
        ticketId: "den-1",
        runId: "task-1",
        source: "manager",
        type: "dispatched",
      }),
    );
  });
});

class FakeDb {
  enqueued: DispatchTaskInput[] = [];
  upsertTicketDispatchedCalls: object[] = [];
  recordEventCalls: object[] = [];

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    this.enqueued.push(input);
    return {
      id: `task-${this.enqueued.length}`,
      ticketId: input.ticketIssueId,
      dispatchState: input.state,
      attemptNumber: this.enqueued.length,
      input,
      workerId: null,
      resultStatus: null,
      result: null,
      slotStatus: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      releasedAt: null,
      iterationNumber: 1,
      workerHeartbeatAt: null,
      reclaimCount: 0,
    } as TaskRecord;
  }

  async upsertTicketDispatched(ref: object): Promise<void> {
    this.upsertTicketDispatchedCalls.push(ref);
  }

  async recordEvent(event: object): Promise<void> {
    this.recordEventCalls.push(event);
  }
}
