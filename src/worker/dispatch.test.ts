import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult, WorkerInputContext } from "./types.js";

const dispatchMock = vi.hoisted(() => ({
  calls: [] as string[],
  piInputs: [] as Array<{ llmProvider: string; llmApiKey: string | null; llmModel?: string }>,
  workspaceDir: "/tmp/dispatch-workspace",
}));

vi.mock("./clone.js", () => ({
  workspaceForTicket: () => dispatchMock.workspaceDir,
  runWorkspaceBuilder: async () => {
    dispatchMock.calls.push("clone");
    return {
      agentWorkdir: join(dispatchMock.workspaceDir, "agent"),
      workspaceDir: dispatchMock.workspaceDir,
      stdout: "",
      stderr: "",
      netrcDir: "/tmp/netrc",
    };
  },
}));

vi.mock("./pi.js", () => ({
  DEFAULT_ANTHROPIC_MODEL_ID: "claude-opus-4-7",
  DEFAULT_BEDROCK_MODEL_ID: "us.anthropic.claude-opus-4-6-v1",
  runPiWorker: async (input: {
    context: WorkerInputContext;
    llmProvider: string;
    llmApiKey: string | null;
    llmModel?: string;
  }): Promise<DispatchResult> => {
    dispatchMock.calls.push("pi");
    dispatchMock.piInputs.push({
      llmProvider: input.llmProvider,
      llmApiKey: input.llmApiKey,
      ...(input.llmModel ? { llmModel: input.llmModel } : {}),
    });
    return { status: "pending", prs: [] };
  },
}));

describe("dispatch", () => {
  beforeEach(() => {
    dispatchMock.calls.length = 0;
    dispatchMock.piInputs.length = 0;
  });

  it("routes research-labeled tickets to Bedrock case-insensitively", async () => {
    const { dispatch } = await import("./dispatch.js");
    const integrations = makeIntegrations();
    integrations.linear.getTicketContext.mockResolvedValue(
      makeTicketContext({ labels: ["Research"] }),
    );

    await dispatch({
      state: "new",
      ticketId: "ABC-1",
      prs: [],
      integrations,
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000,
      llmProvider: "amazon-bedrock",
      llmApiKey: null,
      anthropicApiKey: "anthropic-key",
    });

    expect(dispatchMock.piInputs).toEqual([
      {
        llmProvider: "amazon-bedrock",
        llmApiKey: null,
        llmModel: "us.anthropic.claude-opus-4-6-v1",
      },
    ]);
  });

  it("overrides an Anthropic process provider for a research ticket", async () => {
    const { dispatch } = await import("./dispatch.js");
    const integrations = makeIntegrations();
    integrations.linear.getTicketContext.mockResolvedValue(
      makeTicketContext({ labels: ["research"] }),
    );

    await dispatch({
      state: "new",
      ticketId: "ABC-1",
      prs: [],
      integrations,
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000,
      llmProvider: "anthropic",
      llmApiKey: "anthropic-key",
      anthropicApiKey: "anthropic-key",
    });

    expect(dispatchMock.piInputs).toEqual([
      {
        llmProvider: "amazon-bedrock",
        llmApiKey: null,
        llmModel: "us.anthropic.claude-opus-4-6-v1",
      },
    ]);
  });

  it("routes the ticket after a research ticket to Anthropic without leaking the override", async () => {
    const { dispatch } = await import("./dispatch.js");
    const researchIntegrations = makeIntegrations();
    researchIntegrations.linear.getTicketContext.mockResolvedValue(
      makeTicketContext({ labels: ["research"] }),
    );

    await dispatch({
      state: "new",
      ticketId: "ABC-1",
      prs: [],
      integrations: researchIntegrations,
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000,
      llmProvider: "amazon-bedrock",
      llmApiKey: null,
      anthropicApiKey: "anthropic-key",
    });

    await dispatch({
      state: "new",
      ticketId: "ABC-2",
      prs: [],
      integrations: makeIntegrations(),
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000,
      llmProvider: "amazon-bedrock",
      llmApiKey: null,
      anthropicApiKey: "anthropic-key",
    });

    expect(dispatchMock.piInputs).toEqual([
      {
        llmProvider: "amazon-bedrock",
        llmApiKey: null,
        llmModel: "us.anthropic.claude-opus-4-6-v1",
      },
      {
        llmProvider: "anthropic",
        llmApiKey: "anthropic-key",
        llmModel: "claude-opus-4-7",
      },
    ]);
  });

  it("rejects an unlabeled ticket when the Anthropic credential is unavailable", async () => {
    const { dispatch } = await import("./dispatch.js");
    const tempRoot = await mkdtemp(join(tmpdir(), "dispatch-no-credentials-"));
    const workspaceDir = join(tempRoot, "ABC-1");
    dispatchMock.workspaceDir = workspaceDir;

    try {
      await expect(dispatch({
        state: "new",
        ticketId: "ABC-1",
        prs: [],
        integrations: makeIntegrations(),
        maxWorkerTimeMs: 7_200_000,
        maxWorkerTokens: 20_000_000,
        llmProvider: "amazon-bedrock",
        llmApiKey: null,
        anthropicApiKey: null,
      })).rejects.toThrow(/ANTHROPIC_API_KEY is required/);

      expect(dispatchMock.piInputs).toEqual([]);
      await expect(stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      dispatchMock.workspaceDir = "/tmp/dispatch-workspace";
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("moves the Linear ticket to In Progress before starting Pi", async () => {
    const { dispatch } = await import("./dispatch.js");
    dispatchMock.calls.length = 0;
    const moveTicketToInProgress = vi.fn(async () => {
      dispatchMock.calls.push("in-progress");
    });

    const result = await dispatch({
      state: "new",
      ticketId: "ABC-1",
      prs: [],
      integrations: {
        github: makeGithub(),
        linear: {
          getTicketContext: vi.fn(async () => makeTicketContext()),
          getTicketAttachments: vi.fn(async () => []),
          getAccessToken: vi.fn(async () => "test-token"),
          moveTicketToInProgress,
          moveTicketToInReview: vi.fn(),
          commentAndHandBack: vi.fn(),
          getUserEmail: vi.fn().mockResolvedValue(null),
        },
      },
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result).toEqual({ status: "pending", prs: [] });
    expect(moveTicketToInProgress).toHaveBeenCalledWith("ABC-1");
    expect(dispatchMock.calls.indexOf("in-progress")).toBeLessThan(dispatchMock.calls.indexOf("pi"));
  });

  it("reads the download token after attachment discovery completes", async () => {
    const { dispatch } = await import("./dispatch.js");
    dispatchMock.calls.length = 0;
    const integrations = makeIntegrations();
    let finishAttachmentDiscovery!: (attachments: []) => void;
    integrations.linear.getTicketAttachments.mockImplementation(
      () => new Promise<[]>((resolve) => { finishAttachmentDiscovery = resolve; }),
    );

    const result = dispatch({
      state: "new",
      ticketId: "ABC-1",
      prs: [],
      integrations,
      maxWorkerTimeMs: 7_200_000,
      maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    await vi.waitFor(() => expect(integrations.linear.getTicketAttachments).toHaveBeenCalled());
    expect(integrations.linear.getAccessToken).not.toHaveBeenCalled();
    finishAttachmentDiscovery([]);
    await result;
    expect(integrations.linear.getAccessToken).toHaveBeenCalledOnce();
  });

  describe("cleanup", () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), "dispatch-cleanup-"));
      dispatchMock.workspaceDir = tempRoot;
      // Simulate a checked-out tree from a previous workspace builder run.
      await mkdir(join(tempRoot, "agent", "src"), { recursive: true });
      await writeFile(join(tempRoot, "agent", "marker.txt"), "present", "utf8");
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      dispatchMock.workspaceDir = "/tmp/dispatch-workspace";
    });

    it("removes the agent workdir after Pi finishes", async () => {
      const { dispatch } = await import("./dispatch.js");
      dispatchMock.calls.length = 0;

      await dispatch({
        state: "new",
        ticketId: "ABC-1",
        prs: [],
        integrations: makeIntegrations(),
        maxWorkerTimeMs: 7_200_000,
        maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
      });

      await expect(stat(join(tempRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("removes the agent workdir even when Pi throws", async () => {
      const pi = await import("./pi.js");
      const spy = vi.spyOn(pi, "runPiWorker").mockRejectedValueOnce(new Error("boom"));
      const { dispatch } = await import("./dispatch.js");
      dispatchMock.calls.length = 0;

      await expect(
        dispatch({
          state: "new",
          ticketId: "ABC-1",
          prs: [],
          integrations: makeIntegrations(),
          maxWorkerTimeMs: 7_200_000,
          maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
        }),
      ).rejects.toThrow("boom");

      await expect(stat(join(tempRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
      spy.mockRestore();
    });
  });
});

function makeTicketContext(issueOverrides: Partial<WorkerInputContext["ticket"]["issue"]> = {}) {
  return {
    issue: {
      id: "issue-id",
      identifier: "ABC-1",
      title: "Build thing",
      description: null,
      url: "https://linear.app/your-workspace/issue/ABC-1/build-thing",
      branchName: "feature/abc-1-build-thing",
      status: { name: "Todo", type: "unstarted" },
      labels: ["bear-metal"],
      teamKey: "ABC",
      assignee: { id: "creator" },
      delegate: { id: "agent" },
      priority: 0,
      ...issueOverrides,
    },
    comments: [],
  };
}

function makeIntegrations() {
  return {
    github: makeGithub(),
    linear: {
      getTicketContext: vi.fn(async () => makeTicketContext()),
      getTicketAttachments: vi.fn(async () => []),
      getAccessToken: vi.fn(async () => "test-token"),
      moveTicketToInProgress: vi.fn(async () => {}),
      moveTicketToInReview: vi.fn(),
      commentAndHandBack: vi.fn(),
      getUserEmail: vi.fn().mockResolvedValue(null),
    },
  };
}

function makeGithub() {
  return {
    getInstallationToken: vi.fn().mockResolvedValue("test-token"),
    getBotIdentity: vi.fn().mockResolvedValue({ login: "bear-metal-app[bot]", id: "bot-id", numericId: 12345 }),
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    leaveComment: vi.fn().mockResolvedValue(undefined),
    getDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
  };
}
