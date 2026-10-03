import { describe, expect, it, vi } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "../db/client.js";
import type { GitHubIntegration } from "../shared/integrations/github/client.js";
import { createLogger } from "../shared/logger.js";
import { SlackResearchWorker } from "./slack-research.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "1.0" };

describe("Slack research worker", () => {
  it("finishes answer submission without waiting for the coordinator run", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "1.3", requestIndex: 1, request: "Find the answer", quote: "Find the answer" })).task;
    let releaseWake: (() => void) | undefined;
    const wakeThread = vi.fn(() => new Promise<void>((resolve) => { releaseWake = resolve; }));
    let submitted = false;
    const worker = new SlackResearchWorker({
      db, github: { getInstallationToken: async () => "token" } as GitHubIntegration,
      config: {} as ConstructorParameters<typeof SlackResearchWorker>[0]["config"],
      logger: createLogger({ name: "test", level: "silent" }), pollIntervalMs: 60_000, wakeThread,
      runAgent: async ({ tools, prompt }) => {
        expect(prompt).not.toContain("500");
        const tool = tools.find((candidate) => candidate.name === "answer_research");
        if (!tool) throw new Error("answer_research missing");
        await tool.execute("answer", { summary: "Short answer.", answer: "Answer" }, undefined, undefined, {} as never);
        submitted = true;
      },
    });
    try {
      await worker.tick();
      const completedBeforeWake = await Promise.race([
        worker.stop().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(completedBeforeWake).toBe(true);
      expect(submitted).toBe(true);
      expect((await db.getSlackTask(task.id))?.state).toBe("awaiting_coordination");
      expect((await db.getSlackTask(task.id))?.summary).toBe("Short answer.");
    } finally {
      releaseWake?.();
      await worker.stop();
      await db.close();
    }
  });
  it("stores the answer for coordination and wakes the owning thread", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "1.1", requestIndex: 1, request: "Find the answer", quote: "Find the answer" })).task;
    const wakeThread = vi.fn(async () => {});
    const worker = new SlackResearchWorker({
      db, github: { getInstallationToken: async () => "token" } as GitHubIntegration,
      config: {} as ConstructorParameters<typeof SlackResearchWorker>[0]["config"],
      logger: createLogger({ name: "test", level: "silent" }), pollIntervalMs: 60_000, wakeThread,
      runAgent: async ({ tools, task: customizationTask, prompt }) => {
        expect(customizationTask).toMatchObject({ type: "research", request: "Find the answer" });
        expect(prompt).not.toContain("Question quote:");
        expect(prompt).toContain("answer_research");
        const tool = tools.find((candidate) => candidate.name === "answer_research");
        if (!tool) throw new Error("answer_research missing");
        await tool.execute("answer", { summary: "It is 42.", answer: "The answer is 42" }, undefined, undefined, {} as never);
      },
    });
    try {
      await worker.tick();
      await worker.stop();
      expect((await db.getSlackTask(task.id))?.state).toBe("awaiting_coordination");
      expect((await db.getSlackTask(task.id))?.result).toBe("The answer is 42");
      expect((await db.getSlackTask(task.id))?.summary).toBe("It is 42.");
      expect(wakeThread).toHaveBeenCalledWith(key);
    } finally {
      await db.close();
    }
  });

  it("ignores a research answer submitted after cancellation", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "1.2", requestIndex: 1, request: "Old request", quote: "Old request" })).task;
      await db.claimSlackResearchTask();
      await db.cancelSlackTask(task.id);
      expect(await db.completeSlackResearchTask(task.id, "Late answer")).toBeNull();
      expect((await db.getSlackTask(task.id))?.state).toBe("canceled");
    } finally {
      await db.close();
    }
  });
});
