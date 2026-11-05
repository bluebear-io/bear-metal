import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolChoice, BearMetalConfig } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";

const runtime = vi.hoisted(() => ({ tools: [] as string[] }));

vi.mock("./model.js", () => ({ resolveSessionModel: () => ({}) }));
vi.mock("./pi-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-runtime.js")>()),
  createPiSessionRuntime: async (input: { tools: string[] }) => {
    runtime.tools = input.tools;
    throw new Error("stop after tools captured");
  },
}));

async function researchTools(tools: readonly AgentToolChoice[] | undefined): Promise<string[]> {
  const { runSlackAgent } = await import("./slack-agent.js");
  const base = await mkdtemp(join(tmpdir(), "bear-metal-research-tools-test-"));
  vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", base);
  const db = new SqlDbClient("sqlite::memory:", 5);
  await db.initSchema();
  const task = (await db.createSlackTask({
    type: "research", thread: { workspaceId: "T", channelId: "C", threadTs: "100.0" },
    sourceTs: "101.0", requestIndex: 1, request: "request", quote: "request",
  })).task;
  await db.claimSlackResearchTask();
  const config: BearMetalConfig = {
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
    llmProviders: {},
    customizeTask: () => ({
      llm: { provider: "amazon-bedrock", model: "model" },
      buildWorkspace: async ({ workspacePath }) => { await writeFile(join(workspacePath, "README.md"), "ready"); },
      ...(tools ? { tools } : {}),
    }),
  };
  try {
    await expect(runSlackAgent({
      task: { id: task.id, type: "research", request: "request", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } },
      prompt: "prompt", config, db, tools: [], githubToken: "token",
      gateway: { availableTools: () => ["github_read", "linear_read", "slack_read", "web_get", "github_dispatch"], execute: vi.fn() },
    })).rejects.toThrow("stop after tools captured");
    return runtime.tools;
  } finally {
    vi.unstubAllEnvs();
    await db.close();
    await rm(base, { recursive: true, force: true });
  }
}

describe("Slack research tools", () => {
  it("keeps the research set when the task has no tool list", async () => {
    expect(await researchTools(undefined)).toEqual(["github_read", "linear_read", "slack_read", "web_get", "read", "bash", "grep", "find", "ls"]);
  });

  it("narrows to the role's tools and never widens past the research set", async () => {
    expect(await researchTools(["read", "grep", "linear_read", "edit", "write", "push_for_review", "github_dispatch"])).toEqual(["linear_read", "read", "grep"]);
  });
});
