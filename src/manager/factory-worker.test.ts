import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { FactoryTaskRequest } from "../factory/task.js";
import { createLogger } from "../shared/logger.js";
import type { runFactoryAgent } from "../worker/factory-agent.js";
import { FactoryTaskWorker } from "./factory-worker.js";

const request = (key: string): FactoryTaskRequest => ({
  idempotencyKey: key, runId: "run-1", owner: "owner@example.com", role: "developer", grants: [],
  repository: "acme/widgets", baseSha: "a".repeat(40), instruction: "Do it",
  deadline: new Date(Date.now() + 60_000).toISOString(), maxTokens: 1_000,
});

describe("factory task worker", () => {
  let db: SqlDbClient;
  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
  });
  afterEach(async () => { await db.close(); });

  const worker = (runAgent: typeof runFactoryAgent, concurrency = 2) => new FactoryTaskWorker({
    db, config: {} as BearMetalConfig, artifacts: { put: async () => "" }, getGithubToken: async () => "token",
    logger: createLogger({ name: "test", level: "silent" }), concurrency, pollIntervalMs: 60_000, runAgent,
  });

  it("runs queued tasks within its own slots and records each outcome", async () => {
    const tasks = await Promise.all(["a:1", "b:1", "c:1"].map(async (key) => (await db.createFactoryTask(request(key))).task));
    let running = 0;
    let peak = 0;
    const factory = worker(async ({ task }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return task.id === tasks[2]!.id
        ? { status: "budget", result: null, error: "Token budget reached" }
        : { status: "succeeded", result: { message: "ok", result: null, checks: [], effects: [], scratch: null, usage: null, artifacts: [] }, error: null };
    }, 2);
    await factory.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await factory.tick();
    await factory.stop();
    expect(peak).toBe(2);
    expect((await db.getFactoryTask(tasks[0]!.id))).toMatchObject({ status: "succeeded", result: { message: "ok" } });
    expect((await db.getFactoryTask(tasks[2]!.id))).toMatchObject({ status: "budget", error: "Token budget reached" });
  });

  it("tells a running task it was canceled and keeps the canceled status", async () => {
    const { task } = await db.createFactoryTask(request("a:1"));
    const factory = worker(async ({ canceled }) => {
      await db.cancelFactoryTask(task.id);
      expect(await canceled()).toBe(true);
      return { status: "failed", result: null, error: "Canceled by the factory" };
    });
    await factory.tick();
    await factory.stop();
    expect((await db.getFactoryTask(task.id))).toMatchObject({ status: "canceled", error: "Canceled by the factory" });
  });

  it("fails a task whose runner throws, and fails tasks left running by a restart", async () => {
    const { task } = await db.createFactoryTask(request("a:1"));
    const factory = worker(async () => { throw new Error("boom"); });
    await factory.tick();
    await factory.stop();
    expect((await db.getFactoryTask(task.id))).toMatchObject({ status: "failed", error: "boom" });

    const { task: interrupted } = await db.createFactoryTask(request("b:1"));
    await db.claimFactoryTask();
    await db.recoverFactoryTasks();
    expect((await db.getFactoryTask(interrupted.id))).toMatchObject({ status: "failed", error: "Bear Metal restarted while the task was running" });
  });
});
