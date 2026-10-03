import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import { runSlackAgent } from "./slack-agent.js";

describe("Slack agent run visibility", () => {
  it("builds research workspaces under the configured task workspace directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "bear-metal-research-base-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", base);
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const task = (await db.createSlackTask({
      type: "research", thread: { workspaceId: "T", channelId: "C", threadTs: "100.0" },
      sourceTs: "101.0", requestIndex: 1, request: "request", quote: "request",
    })).task;
    await db.claimSlackResearchTask();
    let builtAt: string | undefined;
    const config: BearMetalConfig = {
      linear: { clientId: "id", getClientSecret: () => "secret" },
      github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
      llmProviders: {},
      customizeTask: () => ({
        llm: { provider: "amazon-bedrock", model: "model" },
        buildWorkspace: async ({ workspacePath }) => {
          builtAt = workspacePath;
          await writeFile(join(workspacePath, "README.md"), "ready");
          throw new Error("stop after workspace path captured");
        },
      }),
    };
    try {
      await expect(runSlackAgent({
        task: { id: task.id, type: "research", request: "request", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } },
        prompt: "prompt", config, db, tools: [], githubToken: "token",
      })).rejects.toThrow("stop after workspace path captured");
      expect(builtAt).toBe(join(base, "research", task.id, "agent"));
      expect(existsSync(join(base, "research", task.id))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await db.close();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("shares one configured checkout across coordinator runs", async () => {
    const base = await mkdtemp(join(tmpdir(), "bear-metal-coordinator-base-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", base);
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const builtPaths: string[] = [];
    const config: BearMetalConfig = {
      linear: { clientId: "id", getClientSecret: () => "secret" },
      github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
      llmProviders: {},
      customizeTask: () => ({
        llm: { provider: "amazon-bedrock", model: "missing-model" },
        buildWorkspace: async ({ workspacePath }) => {
          builtPaths.push(workspacePath);
          await writeFile(join(workspacePath, "AGENTS.md"), "Repository guidance");
        },
      }),
    };
    try {
      for (const id of ["coord-first", "coord-second"]) {
        await expect(runSlackAgent({
          task: { id, type: "coordinator", request: "request", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } },
          prompt: "prompt", config, db, tools: [], getGithubToken: async () => "token",
        })).rejects.toThrow("No model found");
      }
      expect(builtPaths).toHaveLength(1);
      expect(builtPaths[0]?.startsWith(join(base, "coordinator"))).toBe(true);
      const promptEvent = (await db.getAgentRunDetail("coord-first"))?.trace.find((event) => event.kind === "prompt");
      expect(JSON.parse(promptEvent?.contentJson ?? "{}").text).toContain("Repository guidance");
    } finally {
      vi.unstubAllEnvs();
      await db.close();
      await rm(base, { recursive: true, force: true });
    }
  });

  it("records coordinator failures before model selection", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const config: BearMetalConfig = {
      linear: { clientId: "id", getClientSecret: () => "secret" },
      github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
      llmProviders: {},
      customizeTask: () => { throw new Error("model routing failed"); },
    };
    try {
      await expect(runSlackAgent({
        task: { id: "coord-failed", type: "coordinator", request: "request", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } },
        prompt: "prompt", config, db, tools: [],
      })).rejects.toThrow("model routing failed");
      expect((await db.getAgentRunDetail("coord-failed"))?.run).toMatchObject({ status: "failed", error: "Error: model routing failed" });
    } finally {
      await db.close();
    }
  });
});
