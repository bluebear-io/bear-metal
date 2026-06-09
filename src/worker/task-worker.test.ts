import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../shared/index.js";
import type { DispatchTaskInput, TaskQueue, TaskRecord } from "../manager/tasks.js";
import { TaskWorker } from "./task-worker.js";
import type { DispatchInput, DispatchResult } from "./dispatch.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("TaskWorker", () => {
  it("acquires a task with its worker id and writes the dispatch result", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", pr: null };
    const tasks = new FakeTaskQueue(taskRecord({ input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => ({
      status: "done",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 7 },
    }));
    const worker = new TaskWorker({
      logger,
      tasks,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      runDispatch,
    });

    await worker.tick();
    await worker.stop();

    expect(tasks.acquiredBy).toEqual(["worker-1"]);
    expect(runDispatch).toHaveBeenCalledWith({
      ...input,
      integrations: expect.any(Object),
      packageRoot: undefined,
    });
    expect(tasks.completed).toEqual([
      {
        taskId: "task-1",
        result: {
          status: "done",
          pr: { owner: "bluebear-io", repo: "bear-metal", number: 7 },
        },
      },
    ]);
  });
});

function taskRecord(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    ticketId: "DEN-1",
    dispatchState: "new",
    input: { state: "new", ticketId: "DEN-1", pr: null },
    workerId: null,
    resultStatus: null,
    result: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

class FakeTaskQueue implements TaskQueue {
  acquiredBy: string[] = [];
  completed: Array<{ taskId: string; result: DispatchResult }> = [];
  private task: TaskRecord | null;

  constructor(task: TaskRecord | null) {
    this.task = task;
  }

  async initialize(): Promise<void> {}

  async enqueue(_input: DispatchTaskInput): Promise<TaskRecord> {
    throw new Error("FakeTaskQueue.enqueue is not used by TaskWorker tests");
  }

  async acquireNext(workerId: string): Promise<TaskRecord | null> {
    this.acquiredBy.push(workerId);
    if (!this.task) {
      return null;
    }
    const task = { ...this.task, workerId };
    this.task = null;
    return task;
  }

  async complete(taskId: string, result: DispatchResult): Promise<void> {
    this.completed.push({ taskId, result });
  }

  async getCompleted(): Promise<TaskRecord[]> {
    return [];
  }

  async close(): Promise<void> {}
}

function makeIntegrations() {
  return {
    github: {
      getPullRequestContext: vi.fn(),
      resolveReviewThread: vi.fn(),
      replyToReviewThread: vi.fn(),
      getDefaultBranch: vi.fn(),
      createPullRequest: vi.fn(),
    },
    linear: {
      getTicketContext: vi.fn(),
      moveTicketToInProgress: vi.fn(),
      commentAndHandBack: vi.fn(),
    },
  };
}
