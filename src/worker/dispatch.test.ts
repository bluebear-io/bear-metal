import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BearMetalConfig } from "../customization/types.js";
import type { WorkerInputContext } from "./types.js";

const state = vi.hoisted(() => ({ calls: [] as string[], piInputs: [] as any[], tasks: [] as any[], downloadedAttachments: [] as any[], throwPi: false }));
vi.mock("./pi.js", () => ({
  runPiWorker: async (input: any) => {
    state.calls.push("pi"); state.piInputs.push(input);
    if (state.throwPi) throw new Error("pi failed");
    return { status: "pending", prs: [] };
  },
}));
vi.mock("./attachments.js", () => ({
  downloadTicketAttachments: async (attachments: any[]) => {
    state.downloadedAttachments.push(attachments);
    return [];
  },
}));

describe("dispatch customization boundary", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bear-metal-dispatch-test-"));
    process.env.BEAR_METAL_WORKSPACE_DIR = root;
    state.calls.length = 0; state.piInputs.length = 0; state.tasks.length = 0; state.downloadedAttachments.length = 0; state.throwPi = false;
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

  it("uses context attachments once, exposes all to customization, and downloads only Linear uploads", async () => {
    const ticket = makeTicketContext();
    ticket.attachments = [
      { id: "upload", title: "Evidence", url: "https://uploads.linear.app/evidence" },
      { id: "link", title: "Design", url: "https://example.com/design" },
    ];
    const integrations = makeIntegrations({ ticket });

    await dispatch(makeConfig(), { integrations });

    expect(integrations.linear.getTicketContext).toHaveBeenCalledOnce();
    expect(integrations.linear.getTicketAttachments).not.toHaveBeenCalled();
    expect(state.tasks[0].attachments).toEqual(ticket.attachments);
    expect(state.downloadedAttachments).toEqual([[ticket.attachments[0]]]);
  });

  it("skips completed-comment storage when a pull request has no issue comments", async () => {
    const pullRequest = makePullRequestContext([]);
    const commentStore = { getCompleted: vi.fn(), markCompleted: vi.fn() };
    await dispatch(makeConfig(), { state: "iteration", prs: [{ owner: "acme", repo: "repo", number: 1 }], integrations: makeIntegrations({ pullRequest, commentStore }) });

    expect(commentStore.getCompleted).not.toHaveBeenCalled();
    expect(state.piInputs[0].context.pullRequests[0]).toBe(pullRequest);
  });

  it("preserves the pull request context when no issue comments are completed", async () => {
    const pullRequest = makePullRequestContext([{ id: "comment-1", body: "Review", author: "reviewer", authorId: null, databaseId: 1, isMinimized: false, createdAt: "created", updatedAt: "updated" }]);
    const commentStore = { getCompleted: vi.fn(async () => new Set<string>()), markCompleted: vi.fn() };
    await dispatch(makeConfig(), { state: "iteration", prs: [{ owner: "acme", repo: "repo", number: 1 }], integrations: makeIntegrations({ pullRequest, commentStore }) });

    expect(commentStore.getCompleted).toHaveBeenCalledOnce();
    expect(state.piInputs[0].context.pullRequests[0]).toBe(pullRequest);
  });
});

async function dispatch(config: BearMetalConfig, options: { state?: "new" | "iteration"; prs?: Array<{ owner: string; repo: string; number: number }>; integrations?: ReturnType<typeof makeIntegrations> } = {}) {
  const { dispatch } = await import("./dispatch.js");
  return dispatch({ state: options.state ?? "new", iteration: 1, ticketId: "ABC-1", runId: "run-1", prs: options.prs ?? [], integrations: options.integrations ?? makeIntegrations(), agentToolGateway: { availableTools: () => [], execute: vi.fn() }, config });
}

function makeConfig(): BearMetalConfig {
  return {
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 2, getPrivateKey: () => "private" },
    agentIntegrations: {
      github: { appId: 3, installationId: 4, getPrivateKey: () => "agent-private" },
      linear: { clientId: "agent-id", getClientSecret: () => "agent-secret" },
      slack: { getBotToken: () => "agent-slack" },
    },
    llmProviders: { anthropic: { getApiKey: vi.fn(() => "anthropic-key") }, openai: { getApiKey: vi.fn(() => "openai-key") } },
    customizeTask: async (task) => {
      expect(task.identifier).toBe("ABC-1"); expect(Object.isFrozen(task)).toBe(true); state.tasks.push(task); state.calls.push("customize");
      return { llm: { provider: "openai", model: "gpt-test" }, additionalSystemPrompt: "Extra", limits: { maxDurationMs: 123, maxTokens: 456 }, buildWorkspace: async ({ workspacePath }) => { state.calls.push("build"); await writeFile(join(workspacePath, "README.md"), "ready"); } };
    },
  };
}

function makeIntegrations(options: { ticket?: WorkerInputContext["ticket"]; pullRequest?: any; commentStore?: any } = {}) {
  return {
    github: {
      getInstallationToken: vi.fn(async () => "github-token"), getBotIdentity: vi.fn(async () => ({ login: "bear-metal", id: "bot", numericId: 1, userNumericId: 1 })), getPullRequestContext: vi.fn(async () => options.pullRequest), resolveReviewThread: vi.fn(), replyToReviewThread: vi.fn(), leaveComment: vi.fn(), getDefaultBranch: vi.fn(), createPullRequest: vi.fn(),
    },
    linear: {
      getTicketContext: vi.fn(async () => options.ticket ?? makeTicketContext()), getTicketAttachments: vi.fn(async () => []), getAccessToken: vi.fn(async () => "linear-token"), moveTicketToInProgress: vi.fn(async () => { state.calls.push("in-progress"); }), moveTicketToInReview: vi.fn(), commentAndHandBack: vi.fn(), getUserEmail: vi.fn(async () => null),
    },
    commentStore: options.commentStore,
  };
}

function makeTicketContext(): WorkerInputContext["ticket"] {
  return { issue: { id: "id", identifier: "ABC-1", title: "Task", description: null, url: "https://linear.app/ABC-1", branchName: "branch", status: { name: "Todo", type: "unstarted" }, priority: 0, labels: [], teamKey: "ABC", assignee: null, delegate: null }, comments: [] };
}

function makePullRequestContext(issueComments: any[]) {
  return { pullRequest: { number: 1 }, headSha: "sha", failedCheckRuns: [], failedStatuses: [], unresolvedReviewThreads: [], reviewThreads: [], issueComments, completedIssueComments: [], mergeable: true };
}
