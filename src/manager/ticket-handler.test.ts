import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../shared/index.js";

import type { DashboardReporter } from "./dashboardReporter.js";
import { ManagerTicketHandler } from "./ticket-handler.js";
import { makeContext } from "./test-helpers.js";
import type { DispatchTaskInput, TaskQueue, TaskRecord } from "./tasks.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("ManagerTicketHandler", () => {
  it("enqueues a new task and returns the SQL task id", async () => {
    const tasks = new FakeTaskQueue();
    const handler = new ManagerTicketHandler({ logger, tasks });
    const ctx = makeContext("den-1");

    const outcome = await handler.handle(ctx, "new");

    expect(tasks.enqueued).toEqual([
      { state: "new", ticketId: "DEN-1", pr: null, trigger: "new", ticketIssueId: "den-1" },
    ]);
    expect(outcome.status).toBe("pending");
    expect(outcome.taskId).toBe("task-1");
  });

  it("enqueues an iteration task with a compact pull request ref", async () => {
    const tasks = new FakeTaskQueue();
    const handler = new ManagerTicketHandler({ logger, tasks });

    await handler.handle(
      {
        ticket: makeContext("den-2").ticket,
        pr: {
          owner: "bluebear-io",
          repo: "bear-metal",
          number: 5,
          title: "PR",
          headRef: "feature/den-2",
          state: "open",
          draft: false,
          merged: false,
          url: "https://github.com/bluebear-io/bear-metal/pull/5",
        },
      },
      "delegated_back",
    );

    expect(tasks.enqueued).toEqual([
      {
        state: "iteration",
        ticketId: "DEN-2",
        pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
        trigger: "delegated_back",
        ticketIssueId: "den-2",
      },
    ]);
  });

  it("reports the dispatched run to the dashboard reporter", async () => {
    const tasks = new FakeTaskQueue();
    const runDispatched = vi.fn();
    const reporter = { runDispatched } as unknown as DashboardReporter;
    const handler = new ManagerTicketHandler({ logger, tasks, reporter });
    const ctx = makeContext("den-1");

    await handler.handle(ctx, "new");

    expect(runDispatched).toHaveBeenCalledTimes(1);
    expect(runDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: ctx.ticket,
        runId: "task-1",
        workerId: null,
        attemptNumber: 1,
        trigger: "new",
      }),
    );
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
      attemptNumber: this.enqueued.length,
      input,
      workerId: null,
      resultStatus: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
  }

  async acquireNext(): Promise<TaskRecord | null> {
    return null;
  }

  async complete(): Promise<void> {}

  async getCompleted(): Promise<TaskRecord[]> {
    return [];
  }

  async close(): Promise<void> {}
}
