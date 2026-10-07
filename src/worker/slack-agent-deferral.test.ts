import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import { runSlackAgent } from "./slack-agent.js";

const sessionFactory = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  createAgentSession: sessionFactory,
}));

describe("Slack agent review deferral", () => {
  it("aborts the review session and records a clean deferred run", async () => {
    const base = await mkdtemp(join(tmpdir(), "bear-metal-deferred-review-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", base);
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    let deferred = false;
    let notifyAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { notifyAbort = resolve; });
    const abort = vi.fn(async () => { notifyAbort?.(); });
    const listeners: Array<(event: unknown) => void> = [];
    const tool = defineTool({
      name: "defer_review", label: "Defer review", description: "Defer on a newer message",
      parameters: Type.Object({}),
      execute: async () => {
        deferred = true;
        return { content: [{ type: "text" as const, text: "Deferred" }], details: { deferred: true } };
      },
    });
    sessionFactory.mockResolvedValue({ session: {
      subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
      prompt: async () => {
        const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
        for (const listener of listeners) listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: tool.name, result, isError: false });
        await aborted;
      },
      abort,
      getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      dispose: vi.fn(),
    } });
    const config: BearMetalConfig = {
      linear: { clientId: "id", getClientSecret: () => "secret" },
      github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
      llmProviders: { anthropic: { getApiKey: () => "test-key" } },
      customizeTask: () => ({
        llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        buildWorkspace: async ({ workspacePath }) => { await writeFile(join(workspacePath, "AGENTS.md"), "Repository guidance"); },
      }),
    };
    try {
      await runSlackAgent({
        task: { id: "review-deferred", type: "coordinator", request: "review", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } },
        prompt: "Review answer", config, db, tools: [tool], getGithubToken: async () => "token",
        stopRequested: () => deferred,
        validateOutcome: async () => { expect(deferred).toBe(true); },
        output: async () => ({ decision: "Research review deferred." }),
      });
      expect(abort).toHaveBeenCalledTimes(1);
      expect((await db.getAgentRunDetail("review-deferred"))?.run).toMatchObject({ status: "succeeded", stopReason: "deferred", error: null });
      expect((await db.getAgentRunDetail("review-deferred"))?.run.resultJson).toBe('{"decision":"Research review deferred."}');
    } finally {
      sessionFactory.mockReset();
      vi.unstubAllEnvs();
      await db.close();
      await rm(base, { recursive: true, force: true });
    }
  });
});
