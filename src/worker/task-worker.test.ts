import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../shared/index.js";
import type { DispatchTaskInput, TaskQueue, TaskRecord } from "../manager/tasks.js";
import { TaskWorker } from "./task-worker.js";
import type { DispatchInput, DispatchResult } from "./dispatch.js";
import type { DashboardReporter } from "../manager/dashboardReporter.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("TaskWorker", () => {
  it("acquires a task with its worker id and writes the dispatch result", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const tasks = new FakeTaskQueue(taskRecord({ input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => ({
      status: "done",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 7 }],
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
          prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 7 }],
        },
      },
    ]);
  });

  it("reports run lifecycle, worker rows, and progress events through the reporter", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const pr = { owner: "bluebear-io", repo: "bear-metal", number: 7 };
    const tasks = new FakeTaskQueue(taskRecord({ id: "task-1", attemptNumber: 2, input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => ({
      status: "done",
      prs: [pr],
    }));
    const reporter = makeReporter();
    const worker = new TaskWorker({
      logger,
      tasks,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      runDispatch,
      reporter: reporter as unknown as DashboardReporter,
    });

    await worker.tick();
    await worker.stop();

    expect(reporter.runStartedById).toHaveBeenCalledWith("task-1", "lin_1", "worker-1", 2, "new");
    expect(reporter.workerUpsert).toHaveBeenCalledWith("worker-1", expect.any(String), "busy", "task-1", expect.any(Number));
    expect(reporter.branchCreatedById).toHaveBeenCalledWith("lin_1", "task-1", "worker-1", "Branch for DEN-1");
    expect(reporter.progressById).toHaveBeenCalledWith("lin_1", "task-1", "worker-1", "Worker finished: done");
    expect(reporter.runSucceededById).toHaveBeenCalledWith("task-1", "lin_1", "worker-1", 2, "new");
    expect(reporter.recordPrOpenedById).toHaveBeenCalledWith("lin_1", pr, "task-1");
    expect(reporter.workerUpsert).toHaveBeenLastCalledWith("worker-1", expect.any(String), "idle", null, expect.any(Number));
    expect(reporter.runCrashedById).not.toHaveBeenCalled();
  });
});

function makeReporter() {
  return {
    workerUpsert: vi.fn(),
    runStartedById: vi.fn(),
    runSucceededById: vi.fn(),
    runCrashedById: vi.fn(),
    recordPrOpenedById: vi.fn(),
    progressById: vi.fn(),
    branchCreatedById: vi.fn(),
  };
}

function taskRecord(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    ticketId: "DEN-1",
    dispatchState: "new",
    attemptNumber: 1,
    input: { state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" },
    workerId: null,
    resultStatus: null,
    result: null,
    slotStatus: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    releasedAt: null,
    iterationNumber: 1,
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

  async listTracked() {
    return [];
  }

  async countTracked(): Promise<number> {
    return 0;
  }

  async setSlotStatus(): Promise<TaskRecord> {
    throw new Error("FakeTaskQueue.setSlotStatus is not used by TaskWorker tests");
  }

  async getIterationCount(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {}
}

function makeIntegrations() {
  return {
    github: {
      getInstallationToken: vi.fn().mockResolvedValue("test-token"),
      getPullRequestContext: vi.fn(),
      resolveReviewThread: vi.fn(),
      replyToReviewThread: vi.fn(),
      getDefaultBranch: vi.fn(),
      createPullRequest: vi.fn(),
    },
    linear: {
      getTicketContext: vi.fn(),
      moveTicketToInProgress: vi.fn(),
      moveTicketToInReview: vi.fn(),
      commentAndHandBack: vi.fn(),
    },
  };
}
