import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import type { WorkerInputContext } from "./types.js";

const state = vi.hoisted(() => ({ calls: [] as string[], piInputs: [] as any[], throwPi: false }));
vi.mock("./pi.js", () => ({
  runPiWorker: async (input: any) => {
    state.calls.push("pi"); state.piInputs.push(input);
    if (state.throwPi) throw new Error("pi failed");
    return { status: "pending", prs: [] };
  },
}));

describe("dispatch customization boundary", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bear-metal-dispatch-test-"));
    process.env.BEAR_METAL_WORKSPACE_DIR = root;
    state.calls.length = 0; state.piInputs.length = 0; state.throwPi = false;
  });
  afterEach(async () => { delete process.env.BEAR_METAL_WORKSPACE_DIR; await rm(root, { recursive: true, force: true }); });

  it("customizes before building and passes exact provider, model, prompt, and limits to Pi", async () => {
    const config = makeConfig();
    const result = await dispatch(config);
    expect(result.status).toBe("pending");
    expect(state.calls).toEqual(["customize", "build", "in-progress", "pi"]);
    expect(state.piInputs[0]).toMatchObject({ llmProvider: "openai", llmModel: "gpt-test", llmApiKey: "openai-key", systemPrompt: "Extra", maxWorkerTimeMs: 123, maxWorkerTokens: 456 });
  });

  it("resolves only the selected provider", async () => {
    const config = makeConfig();
    const anthropic = config.llmProviders.anthropic as { getApiKey: ReturnType<typeof vi.fn> };
    const openai = config.llmProviders.openai as { getApiKey: ReturnType<typeof vi.fn> };
    await dispatch(config);
    expect(openai.getApiKey).toHaveBeenCalledOnce(); expect(anthropic.getApiKey).not.toHaveBeenCalled();
  });

  it("fails before workspace construction when the selected provider is absent", async () => {
    const config = makeConfig(); config.llmProviders = {};
    await expect(dispatch(config)).rejects.toThrow("unconfigured LLM provider");
    expect(state.calls).toEqual(["customize"]);
  });

  it("moves the ticket to In Progress before starting Pi", async () => {
    await dispatch(makeConfig());
    expect(state.calls.indexOf("in-progress")).toBeLessThan(state.calls.indexOf("pi"));
  });

  it("removes the entire owned task workspace on success and Pi failure", async () => {
    await dispatch(makeConfig());
    await expect(stat(join(root, "ABC-1"))).rejects.toMatchObject({ code: "ENOENT" });
    state.throwPi = true;
    await expect(dispatch(makeConfig())).rejects.toThrow("pi failed");
    await expect(stat(join(root, "ABC-1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function dispatch(config: BearMetalConfig) {
  const { dispatch } = await import("./dispatch.js");
  return dispatch({ state: "new", iteration: 1, ticketId: "ABC-1", prs: [], integrations: makeIntegrations(), config });
}

function makeConfig(): BearMetalConfig {
  return {
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 2, getPrivateKey: () => "private" },
    llmProviders: { anthropic: { getApiKey: vi.fn(() => "anthropic-key") }, openai: { getApiKey: vi.fn(() => "openai-key") } },
    customizeTask: async (task) => {
      expect(task.identifier).toBe("ABC-1"); expect(Object.isFrozen(task)).toBe(true); state.calls.push("customize");
      return { llm: { provider: "openai", model: "gpt-test" }, additionalSystemPrompt: "Extra", limits: { maxDurationMs: 123, maxTokens: 456 }, buildWorkspace: async ({ workspacePath }) => { state.calls.push("build"); await writeFile(join(workspacePath, "README.md"), "ready"); } };
    },
  };
}

function makeIntegrations() {
  return {
    github: {
      getInstallationToken: vi.fn(async () => "github-token"), getBotIdentity: vi.fn(async () => ({ login: "bear-metal", id: "bot", numericId: 1, userNumericId: 1 })), getPullRequestContext: vi.fn(), resolveReviewThread: vi.fn(), replyToReviewThread: vi.fn(), leaveComment: vi.fn(), getDefaultBranch: vi.fn(), createPullRequest: vi.fn(),
    },
    linear: {
      getTicketContext: vi.fn(async () => makeTicketContext()), getTicketAttachments: vi.fn(async () => []), getAccessToken: vi.fn(async () => "linear-token"), moveTicketToInProgress: vi.fn(async () => { state.calls.push("in-progress"); }), moveTicketToInReview: vi.fn(), commentAndHandBack: vi.fn(), getUserEmail: vi.fn(async () => null),
    },
  };
}

function makeTicketContext(): WorkerInputContext["ticket"] {
  return { issue: { id: "id", identifier: "ABC-1", title: "Task", description: null, url: "https://linear.app/ABC-1", branchName: "branch", status: { name: "Todo", type: "unstarted" }, priority: 0, labels: [], teamKey: "ABC", assignee: null, delegate: null }, comments: [] };
}
