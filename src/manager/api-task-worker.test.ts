import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { ApiTaskRequest } from "../task-api/request.js";
import { createLogger } from "../shared/logger.js";
import type { runApiTaskAgent } from "../worker/api-task-agent.js";
import type { WorkerGitHub } from "../worker/types.js";
import { vi } from "vitest";
import type { DispatchResult } from "../worker/types.js";
import { ApiTaskWorker, stopTicketWork, ticketRunOutcome } from "./api-task-worker.js";

const request = (key: string): ApiTaskRequest => ({
  idempotencyKey: key, profile: { id: "developer", name: "Developer", instructions: "Do it.", toolCeiling: [], shell: false, customerData: false }, owner: "owner@example.com", repository: "acme/widgets", instruction: "Do it",
  deadline: new Date(Date.now() + 60_000).toISOString(), maxTokens: 1_000,
});

describe("API task worker", () => {
  let db: SqlDbClient;
  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
  });
  afterEach(async () => { await db.close(); });

  const worker = (runAgent: typeof runApiTaskAgent, concurrency = 2) => new ApiTaskWorker({
    db, config: {} as BearMetalConfig, github: {} as WorkerGitHub,
    logger: createLogger({ name: "test", level: "silent" }), concurrency, pollIntervalMs: 60_000, runAgent,
  });

  it("runs queued tasks within its own slots and records each outcome", async () => {
    const tasks = await Promise.all(["a", "b", "c"].map(async (key) => (await db.createApiTask(request(key))).task));
    let running = 0;
    let peak = 0;
    const apiWorker = worker(async ({ task }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return task.id === tasks[2]!.id
        ? { status: "budget", result: null, error: "Token budget reached" }
        : { status: "succeeded", result: { message: "ok", result: null, pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }], usage: null }, error: null };
    }, 2);
    await apiWorker.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await apiWorker.tick();
    await apiWorker.stop();
    expect(peak).toBe(2);
    expect(await db.getApiTask(tasks[0]!.id)).toMatchObject({ status: "succeeded", result: { message: "ok", pullRequests: [{ number: 7 }] } });
    expect(await db.getApiTask(tasks[2]!.id)).toMatchObject({ status: "budget", error: "Token budget reached" });
  });

  it("tells a running task it was canceled and keeps the canceled status", async () => {
    const { task } = await db.createApiTask(request("a"));
    const apiWorker = worker(async ({ canceled }) => {
      await db.cancelApiTask(task.id);
      expect(await canceled()).toBe(true);
      return { status: "failed", result: null, error: "Canceled through the task API" };
    });
    await apiWorker.tick();
    await apiWorker.stop();
    expect(await db.getApiTask(task.id)).toMatchObject({ status: "canceled", error: "Canceled through the task API" });
  });

  it("fails a task whose runner throws, and fails tasks left running by a restart", async () => {
    const { task } = await db.createApiTask(request("a"));
    const apiWorker = worker(async () => { throw new Error("boom"); });
    await apiWorker.tick();
    await apiWorker.stop();
    expect(await db.getApiTask(task.id)).toMatchObject({ status: "failed", error: "boom" });

    const { task: interrupted } = await db.createApiTask(request("b"));
    await db.claimApiTask();
    await db.recoverApiTasks(new Date().toISOString());
    expect(await db.getApiTask(interrupted.id)).toMatchObject({ status: "failed", error: "Bear Metal restarted while the task was running" });
  });

  describe("coding tasks", () => {
    const handBack = vi.fn(async () => {});
    const codingWorker = () => new ApiTaskWorker({
      db, config: {} as BearMetalConfig, github: {} as WorkerGitHub, tickets: { handBack },
      logger: createLogger({ name: "test", level: "silent" }), concurrency: 1, pollIntervalMs: 60_000,
      runAgent: async () => { throw new Error("a coding task never runs in the API task worker"); },
    });
    const delegate = async (key: string, deadline = new Date(Date.now() + 60_000).toISOString()) => {
      const { repository: _repository, ...rest } = request(key);
      const { task } = await db.createApiTask({ ...rest, ticketId: "DEN-1", deadline }, "issue-1");
      await db.startTicketApiTask(task.id);
      return task;
    };
    const finishRun = async (result: DispatchResult) => {
      const run = await db.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "issue-1" });
      await db.acquireNext("worker-1");
      await db.complete(run.id, result, "worker-1");
    };
    const usage = { promptTokens: 30, completionTokens: 5, modelName: "m", provider: "p", tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 13 } };
    beforeEach(() => handBack.mockClear());

    it("succeeds with the first run's pull requests and usage, and keeps the profile for later runs", async () => {
      const task = await delegate("a");
      const apiWorker = codingWorker();
      await apiWorker.tick();
      expect((await db.getApiTask(task.id))?.status).toBe("running");
      await finishRun({ status: "done", prs: [{ owner: "acme", repo: "widgets", number: 7 }], usage });
      await apiWorker.tick();
      expect(await db.getApiTask(task.id)).toMatchObject({
        status: "succeeded", error: null,
        result: {
          message: null, result: null, pullRequests: [{ owner: "acme", repo: "widgets", number: 7 }],
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 13, freshTokens: 28, provider: "p", model: "m" },
        },
      });
      expect((await db.getTicketApiTask("issue-1"))?.id).toBe(task.id);
      expect(handBack).not.toHaveBeenCalled();
    });

    it("hands the ticket back and ends the profile binding when the first run fails, an abandoned run included", async () => {
      const task = await delegate("abandoned");
      const apiWorker = codingWorker();
      await apiWorker.tick();
      await finishRun({ status: "pending", prs: [] });
      await apiWorker.tick();
      expect((await db.getApiTask(task.id))?.status).toBe("failed");
      expect(handBack).toHaveBeenCalledExactlyOnceWith("issue-1");
      expect(await db.getTicketApiTask("issue-1")).toBeNull();
    });

    it("ends the profile binding of a task stopped before its first run, and stops a queued run row cleanly", async () => {
      const task = await delegate("early");
      await db.cancelApiTask(task.id);
      await stopTicketWork(db, { handBack }, "issue-1", "Canceled through the task API");
      expect(await db.getTicketApiTask("issue-1")).toBeNull();

      const queued = await delegate("queued");
      await db.cancelApiTask(queued.id);
      await db.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "issue-1" });
      await stopTicketWork(db, { handBack }, "issue-1", "Canceled through the task API");
      const run = await db.getFirstTicketRun("issue-1", task.createdAt);
      expect(run).toMatchObject({ runStatus: "interrupted", error: "Canceled through the task API" });
      expect(await db.getTicketApiTask("issue-1")).toBeNull();
    });

    it("maps the first run's limits and hand-backs to the task's outcome", () => {
      const run = (result: DispatchResult | null, runStatus: "succeeded" | "crashed" = "succeeded") => ({
        record: { resultStatus: result?.status ?? "pending", result } as never, runStatus, error: "boom",
        stopReason: result?.stopReason ?? null, tokens: null, provider: null, model: null,
      });
      expect(ticketRunOutcome(null)).toBeNull();
      expect(ticketRunOutcome(run({ status: "pending", prs: [], stopReason: "token_limit" }))?.status).toBe("budget");
      expect(ticketRunOutcome(run({ status: "pending", prs: [], stopReason: "time_limit" }))?.status).toBe("timeout");
      expect(ticketRunOutcome(run({ status: "pending", prs: [] }))).toMatchObject({ status: "failed", error: "The ticket's run handed the ticket back to its assignee" });
      expect(ticketRunOutcome(run({ status: "done", prs: [] }))).toMatchObject({ status: "failed", error: "The ticket's run ended without a pull request" });
      expect(ticketRunOutcome(run(null, "crashed"))).toMatchObject({ status: "failed", error: "The ticket's run ended without a result: boom" });
    });

    it("times out at the deadline by handing the ticket back and releasing its slot", async () => {
      const task = await delegate("a", new Date(Date.now() + 50).toISOString());
      await db.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "issue-1" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await codingWorker().tick();
      expect(await db.getApiTask(task.id)).toMatchObject({ status: "timeout", error: expect.stringContaining("reached") });
      expect(handBack).toHaveBeenCalledExactlyOnceWith("issue-1");
      expect(await db.getTrackedSlot("issue-1")).toBeNull();
      expect(await db.getTicketApiTask("issue-1")).toBeNull();
    });

    it("fails a coding task that never delegated its ticket before a restart, and leaves delegated ones running", async () => {
      const { repository: _repository, ...rest } = request("queued");
      const { task: queued } = await db.createApiTask({ ...rest, ticketId: "DEN-2" }, "issue-2");
      const running = await delegate("running");
      await db.recoverApiTasks(new Date(Date.now() + 1_000).toISOString());
      expect(await db.getApiTask(queued.id)).toMatchObject({ status: "failed", error: "Bear Metal restarted before delegating the ticket" });
      expect((await db.getApiTask(running.id))?.status).toBe("running");
    });

    it("allows one unfinished coding task per ticket", async () => {
      await delegate("a");
      await expect(delegate("b")).rejects.toThrow("Ticket DEN-1 already has an unfinished task");
    });
  });
});
