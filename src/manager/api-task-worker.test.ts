import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { ApiTaskRequest } from "../task-api/request.js";
import { createLogger } from "../shared/logger.js";
import type { runApiTaskAgent } from "../worker/api-task-agent.js";
import type { WorkerGitHub } from "../worker/types.js";
import { ApiTaskWorker } from "./api-task-worker.js";

const request = (key: string): ApiTaskRequest => ({
  idempotencyKey: key, profile: "developer", owner: "owner@example.com", repository: "acme/widgets", instruction: "Do it",
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
    await db.recoverApiTasks();
    expect(await db.getApiTask(interrupted.id)).toMatchObject({ status: "failed", error: "Bear Metal restarted while the task was running" });
  });
});
