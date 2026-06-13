import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../shared/index.js";
import type { DbClient, DispatchTaskInput, TaskRecord } from "../db/client.js";
import { TaskWorker } from "./task-worker.js";
import type { DispatchInput, DispatchResult } from "./dispatch.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("TaskWorker", () => {
  it("acquires a task with its worker id and writes the dispatch result", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const db = new FakeDb(taskRecord({ input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => ({
      status: "done",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 7 }],
    }));
    const worker = new TaskWorker({
      logger,
      db: db as unknown as DbClient,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      runDispatch,
    });

    await worker.tick();
    await worker.stop();

    expect(db.acquiredBy).toEqual(["worker-1"]);
    expect(runDispatch).toHaveBeenCalledWith(expect.objectContaining({
      ...input,
      integrations: expect.any(Object),
      packageRoot: undefined,
    }));
    expect(db.completed).toEqual([
      {
        taskId: "task-1",
        result: {
          status: "done",
          prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 7 }],
        },
      },
    ]);
  });

  it("records run lifecycle events in the db", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const db = new FakeDb(taskRecord({ id: "task-1", attemptNumber: 2, input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => ({
      status: "done",
      prs: [],
    }));
    const worker = new TaskWorker({
      logger,
      db: db as unknown as DbClient,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      runDispatch,
    });

    await worker.tick();
    await worker.stop();
    // Allow fire-and-forget db calls to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(db.upsertRunStartedCalls).toEqual([
      expect.objectContaining({ taskId: "task-1", workerId: "worker-1" }),
    ]);
    expect(db.upsertRunSucceededCalls).toEqual([{ taskId: "task-1", usage: null }]);
    expect(db.upsertRunCrashedCalls).toHaveLength(0);
  });

  it("marks the row crashed when runDispatch throws so the task isn't left acquired forever", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const db = new FakeDb(taskRecord({ input }));
    const runDispatch = vi.fn(async (_input: DispatchInput): Promise<DispatchResult> => {
      throw new Error("boom");
    });
    const worker = new TaskWorker({
      logger,
      db: db as unknown as DbClient,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      maxReclaims: 5,
      runDispatch,
    });

    await worker.tick();
    await worker.stop();
    // Let the .catch() microtask + markCrashed promise settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // upsertRunCrashed fires from both runTask's catch and tick()'s outer catch.
    expect(db.upsertRunCrashedCalls.length).toBeGreaterThanOrEqual(1);
    expect(db.upsertRunCrashedCalls[0]).toEqual(expect.objectContaining({ taskId: "task-1" }));
    expect(db.markCrashedCalls).toEqual([{ taskId: "task-1", workerId: "worker-1", maxReclaims: 5 }]);
  });

  it("heartbeats the in-flight task on the configured interval and stops once dispatch returns", async () => {
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_1" };
    const db = new FakeDb(taskRecord({ id: "task-1", input }));

    // Hold dispatch open so we can observe heartbeats firing while the task is in flight.
    let resolveDispatch!: (result: DispatchResult) => void;
    const dispatchDone = new Promise<DispatchResult>((resolve) => {
      resolveDispatch = resolve;
    });
    const runDispatch = vi.fn(() => dispatchDone);

    const worker = new TaskWorker({
      logger,
      db: db as unknown as DbClient,
      integrations: makeIntegrations(),
      concurrency: 1,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
      runDispatch,
      heartbeatIntervalMs: 10,
    });

    await worker.tick();
    // Give the heartbeat timer time to fire at least twice (~3 intervals).
    await new Promise((r) => setTimeout(r, 35));
    expect(db.heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(db.heartbeats[0]).toEqual({ taskId: "task-1", workerId: "worker-1" });

    resolveDispatch({ status: "done", prs: [] });
    await worker.stop();

    const finalCount = db.heartbeats.length;
    await new Promise((r) => setTimeout(r, 25));
    // Once dispatch resolves, the heartbeat interval must be cleared.
    expect(db.heartbeats.length).toBe(finalCount);
  });
});

function taskRecord(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    ticketId: "lin_1",
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
    workerHeartbeatAt: null,
    reclaimCount: 0,
    ...overrides,
  } as TaskRecord;
}

class FakeDb {
  acquiredBy: string[] = [];
  completed: Array<{ taskId: string; result: DispatchResult }> = [];
  heartbeats: Array<{ taskId: string; workerId: string }> = [];
  upsertRunStartedCalls: object[] = [];
  upsertRunSucceededCalls: Array<{ taskId: string; usage: object | null }> = [];
  upsertRunCrashedCalls: object[] = [];
  markCrashedCalls: Array<{ taskId: string; workerId: string; maxReclaims: number }> = [];
  private task: TaskRecord | null;

  constructor(task: TaskRecord | null) {
    this.task = task;
  }

  async enqueue(_input: DispatchTaskInput): Promise<TaskRecord> {
    throw new Error("FakeDb.enqueue is not used by TaskWorker tests");
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
    throw new Error("FakeDb.setSlotStatus is not used by TaskWorker tests");
  }

  async getIterationCount(): Promise<number> {
    return 0;
  }

  async heartbeat(taskId: string, workerId: string): Promise<boolean> {
    this.heartbeats.push({ taskId, workerId });
    return true;
  }

  async reclaimStaleTasks() {
    return [];
  }

  async upsertRunStarted(taskId: string, workerId: string, workerStartedAt: string): Promise<void> {
    this.upsertRunStartedCalls.push({ taskId, workerId, workerStartedAt });
  }

  async upsertRunSucceeded(taskId: string, usage?: object | null): Promise<void> {
    this.upsertRunSucceededCalls.push({ taskId, usage: usage ?? null });
  }

  async upsertRunCrashed(taskId: string, error: string): Promise<void> {
    this.upsertRunCrashedCalls.push({ taskId, error });
  }

  async upsertToolCalls(): Promise<void> {}

  async recordEvent(): Promise<void> {}

  markCrashedCalls_: Array<{ taskId: string; workerId: string; maxReclaims: number }> = [];

  async markCrashed(taskId: string, workerId: string, maxReclaims: number) {
    this.markCrashedCalls.push({ taskId, workerId, maxReclaims });
    return null;
  }

  async close(): Promise<void> {}
}

function makeIntegrations() {
  return {
    github: {
      getInstallationToken: vi.fn().mockResolvedValue("test-token"),
      getBotIdentity: vi.fn().mockResolvedValue({ login: "bear-metal-app[bot]", id: "bot-id", numericId: 12345 }),
      getPullRequestContext: vi.fn(),
      resolveReviewThread: vi.fn(),
      replyToReviewThread: vi.fn(),
      leaveComment: vi.fn().mockResolvedValue(undefined),
      getDefaultBranch: vi.fn(),
      createPullRequest: vi.fn(),
    },
    linear: {
      getTicketContext: vi.fn(),
      moveTicketToInProgress: vi.fn(),
      moveTicketToInReview: vi.fn(),
      commentAndHandBack: vi.fn(),
      getUserEmail: vi.fn().mockResolvedValue(null),
    },
  };
}
