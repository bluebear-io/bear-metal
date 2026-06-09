import { describe, expect, it, vi } from "vitest";
import type { WorkerInputContext } from "./types.js";

type TestTool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

const piMock = vi.hoisted(() => ({
  sessionDispose: vi.fn(),
  runTools: vi.fn(async (customTools: TestTool[]) => {
    const tool = customTools.find((candidate) => candidate.name === "respond_to_ticket_reporter");
    if (!tool) {
      throw new Error("respond_to_ticket_reporter tool was not registered");
    }
    await tool.execute("tool-call-id", { text: "Need a product decision." });
  }),
}));

const gitMock = vi.hoisted(() => ({
  commitAndPush: vi.fn(async () => {}),
  getCurrentBranch: vi.fn(async () => "feature/den-1"),
  getRemoteRef: vi.fn(async () => ({ owner: "acme", repo: "widgets" })),
}));

const makeTool = (name: string) => ({
  name,
  execute: vi.fn(),
});

vi.mock("../shared/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/index.js")>();
  return {
    ...actual,
    commitAndPush: gitMock.commitAndPush,
    getCurrentBranch: gitMock.getCurrentBranch,
    getRemoteRef: gitMock.getRemoteRef,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      setRuntimeApiKey: vi.fn(),
    }),
  },
  ModelRegistry: {
    create: () => ({}),
  },
  SessionManager: {
    inMemory: () => ({}),
  },
  defineTool: (definition: unknown) => definition,
  createLocalBashOperations: () => ({ exec: vi.fn() }),
  createReadToolDefinition: () => makeTool("read"),
  createBashToolDefinition: () => makeTool("bash"),
  createEditToolDefinition: () => makeTool("edit"),
  createWriteToolDefinition: () => makeTool("write"),
  createGrepToolDefinition: () => makeTool("grep"),
  createFindToolDefinition: () => makeTool("find"),
  createLsToolDefinition: () => makeTool("ls"),
  createAgentSession: async (input: { customTools: TestTool[] }) => ({
    session: {
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      exportToJsonl: vi.fn(),
      prompt: async () => piMock.runTools(input.customTools),
      dispose: piMock.sessionDispose,
    },
  }),
}));

describe("runPiWorker", () => {
  it("replies to and resolves an agreed GitHub review thread", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const linear = makeLinear();
    const context = makeContext({
      state: "iteration",
      pr: { owner: "acme", repo: "widgets", number: 7 },
      pullRequest: makePullRequestContext(),
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "agree_with_github_message", {
        threadId: "thread-1",
        text: "Fixed in commit abc123.",
      });
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    await runPiWorker({ context, github, linear, gitEnv: {} });

    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.pr,
      "thread-1",
      "Fixed in commit abc123.",
      context.pullRequest?.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith("thread-1");
  });

  it("replies to and resolves a disagreed GitHub review thread", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const linear = makeLinear();
    const context = makeContext({
      state: "iteration",
      pr: { owner: "acme", repo: "widgets", number: 7 },
      pullRequest: makePullRequestContext(),
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "disagree_with_github_message", {
        threadId: "thread-1",
        text: "The current code already handles this path.",
      });
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    await runPiWorker({ context, github, linear, gitEnv: {} });

    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.pr,
      "thread-1",
      "The current code already handles this path.",
      context.pullRequest?.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith("thread-1");
  });

  it("moves the Linear ticket to In Review after writing code", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    const result = await runPiWorker({
      context: makeContext({ pr: { owner: "acme", repo: "widgets", number: 7 } }),
      github: makeGithub(),
      linear,
      gitEnv: {},
    });

    expect(linear.moveTicketToInReview).toHaveBeenCalledWith("DEN-1");
    expect(result).toEqual({ status: "done", pr: { owner: "acme", repo: "widgets", number: 7 } });
  });

  it("comments and hands the ticket back to its human owner when pending human response", async () => {
    const { runPiWorker } = await import("./pi.js");
    const commentAndHandBack = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = makeContext();

    const result = await runPiWorker({
      context,
      github: makeGithub(),
      linear: {
        ...makeLinear(),
        commentAndHandBack,
      },
      gitEnv: {},
    });

    expect(commentAndHandBack).toHaveBeenCalledWith("DEN-1", "Need a product decision.");
    expect(result).toEqual({ status: "pending", pr: null });
    expect(piMock.sessionDispose).toHaveBeenCalled();
  });
});

function executeTool(customTools: TestTool[], name: string, params: unknown): Promise<unknown> {
  const tool = customTools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool.execute("tool-call-id", params);
}

function makeContext(overrides: Partial<WorkerInputContext> = {}): WorkerInputContext {
  return {
    state: "new",
    ticketId: "DEN-1",
    pr: null,
    ticket: {
      issue: {
        id: "issue-id",
        identifier: "DEN-1",
        title: "Build thing",
        description: null,
        url: "https://linear.app/bluebear/issue/DEN-1/build-thing",
        branchName: "feature/den-1-build-thing",
        status: { name: "Todo", type: "unstarted" },
        labels: ["bear-metal"],
        assignee: { id: "creator" },
        delegate: { id: "user-1" },
      },
      comments: [],
    },
    pullRequest: null,
    cloneScript: {
      scriptPath: "/tmp/script.sh",
      workspaceDir: "/tmp/workspace",
      stdout: "",
      stderr: "",
      netrcDir: "/tmp/netrc",
    },
    ...overrides,
  };
}

function makeGithub() {
  return {
    getInstallationToken: vi.fn().mockResolvedValue("test-token"),
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    getDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
  };
}

function makeLinear() {
  return {
    getTicketContext: vi.fn(),
    moveTicketToInProgress: vi.fn(),
    moveTicketToInReview: vi.fn(),
    commentAndHandBack: vi.fn(),
  };
}

function makePullRequestContext() {
  return {
    pullRequest: { number: 7 },
    failedCheckRuns: [],
    failedStatuses: [],
    unresolvedReviewThreads: [
      {
        id: "thread-1",
        isResolved: false,
        path: "src/file.ts",
        line: 1,
        comments: [
          {
            id: "comment-1",
            databaseId: 123,
            body: "Please check this.",
            author: "reviewer",
            url: "https://github.com/acme/widgets/pull/7#discussion_r123",
            createdAt: "2026-06-09T00:00:00Z",
            updatedAt: "2026-06-09T00:00:00Z",
            path: "src/file.ts",
            line: 1,
            originalLine: 1,
            diffHunk: "@@",
          },
        ],
      },
    ],
  };
}
