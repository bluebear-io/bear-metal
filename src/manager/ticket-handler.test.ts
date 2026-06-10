import { describe, expect, it } from "vitest";

import { createLogger } from "../shared/index.js";

import { ManagerTicketHandler } from "./ticket-handler.js";
import { makeContext } from "./test-helpers.js";
import type { DispatchTaskInput, TaskQueue, TaskRecord } from "./tasks.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("ManagerTicketHandler", () => {
  it("enqueues a new task and returns the SQL task id", async () => {
    const tasks = new FakeTaskQueue();
    const handler = new ManagerTicketHandler({ logger, tasks });
    const ctx = makeContext("den-1");

    const outcome = await handler.handle(ctx);

    expect(tasks.enqueued).toEqual([{ state: "new", ticketId: "DEN-1", prs: [] }]);
    expect(outcome.status).toBe("pending");
    expect(outcome.taskId).toBe("task-1");
  });

  it("enqueues an iteration task with a compact pull request ref", async () => {
    const tasks = new FakeTaskQueue();
    const handler = new ManagerTicketHandler({ logger, tasks });

    await handler.handle({
      ticket: makeContext("den-2").ticket,
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
    });

    expect(tasks.enqueued).toEqual([
      {
        state: "iteration",
        ticketId: "DEN-2",
        prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
      },
    ]);
  });
});

class FakeTaskQueue implements TaskQueue {
  enqueued: DispatchTaskInput[] = [];

  async initialize(): Promise<void> {}

  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    this.enqueued.push(input);
    return {
      id: `task-${this.enqueued.length}`,
      ticketId: input.ticketId,
      dispatchState: input.state,
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
    };
  }

  async acquireNext(): Promise<TaskRecord | null> {
    return null;
  }

  async complete(): Promise<void> {}

  async listTracked() {
    return [];
  }

  async countTracked(): Promise<number> {
    return 0;
  }

  async setSlotStatus(): Promise<TaskRecord> {
    throw new Error("FakeTaskQueue.setSlotStatus is not used by ManagerTicketHandler tests");
  }

  async getIterationCount(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {}
}
