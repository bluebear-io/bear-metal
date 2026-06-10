import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Unique netrc dir per test, assigned in beforeEach; read by makeContext's fixture.
let netrcDir: string;

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
  // In production clone.ts creates netrcDir via mkdtemp before pi runs. Use a unique dir
  // per test (not a shared /tmp path) so a parallel dispatch.test, whose dispatch cleanup
  // rm's its netrcDir, can't delete ours mid-write.
  beforeEach(async () => {
    netrcDir = await mkdtemp(join(tmpdir(), "bear-metal-pi-test-"));
  });

  it("replies to and resolves an agreed GitHub review thread", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const linear = makeLinear();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
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
      context.prs[0],
      "thread-1",
      "Fixed in commit abc123.",
      context.pullRequests[0]?.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith("thread-1");
  });

  it("replies to a disagreed GitHub review thread without resolving it", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const linear = makeLinear();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
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
      context.prs[0],
      "thread-1",
      "The current code already handles this path.",
      context.pullRequests[0]?.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it("replies to a review thread and sets dispatch pending when respond_to_comment_writer is called", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const linear = makeLinear();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "respond_to_comment_writer", {
        threadId: "thread-1",
        text: "I need clarification on the expected behavior here.",
      });
    });

    const result = await runPiWorker({ context, github, linear, gitEnv: {} });

    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.prs[0],
      "thread-1",
      "I need clarification on the expected behavior here.",
      context.pullRequests[0]?.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "pending", prs: context.prs });
  });

  it("returns done when agent only disagrees with all threads and makes no code changes", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "disagree_with_github_message", {
        threadId: "thread-1",
        text: "No change needed.",
      });
      // agent calls no finish tool — disagree-only, no code changes
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {} });

    expect(result).toEqual({ status: "done", prs: context.prs });
  });

  it("allows respond_to_comment_writer to be called for multiple threads without crashing", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-1", text: "Question 1." });
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-2", text: "Question 2." });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {} });

    expect(github.replyToReviewThread).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "pending", prs: context.prs });
  });

  it("returns pending when agent fixes some threads then calls respond_to_comment_writer", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix thread 1",
        prTitle: "fix",
        prBody: "fix",
      });
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-2", text: "Blocked here." });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {} });

    expect(result).toEqual({ status: "pending", prs: context.prs });
  });

  it("preserves pending decision when wrote_code is called after respond_to_comment_writer", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-2", text: "Blocked here." });
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix thread 1",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {} });

    expect(result.status).toBe("pending");
    expect(result.prs).toEqual(context.prs);
  });

  it("registers respond_to_ticket_reporter and wrote_code in new task mode, not iteration tools", async () => {
    const { runPiWorker } = await import("./pi.js");
    const registeredNames: string[] = [];
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      for (const tool of customTools) registeredNames.push(tool.name);
      await executeTool(customTools, "respond_to_ticket_reporter", { text: "Blocked." });
    });

    await runPiWorker({
      context: makeContext({ state: "new" }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {},
    });

    expect(registeredNames).toContain("respond_to_ticket_reporter");
    expect(registeredNames).toContain("wrote_code");
    expect(registeredNames).not.toContain("agree_with_github_message");
    expect(registeredNames).not.toContain("disagree_with_github_message");
    expect(registeredNames).not.toContain("respond_to_comment_writer");
  });

  it("registers iteration tools in iteration mode, not respond_to_ticket_reporter", async () => {
    const { runPiWorker } = await import("./pi.js");
    const registeredNames: string[] = [];
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      for (const tool of customTools) registeredNames.push(tool.name);
      await executeTool(customTools, "respond_to_comment_writer", {
        threadId: "thread-1",
        text: "Blocked.",
      });
    });

    await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [makePullRequestContext()],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {},
    });

    expect(registeredNames).toContain("agree_with_github_message");
    expect(registeredNames).toContain("disagree_with_github_message");
    expect(registeredNames).toContain("respond_to_comment_writer");
    expect(registeredNames).toContain("wrote_code");
    expect(registeredNames).not.toContain("respond_to_ticket_reporter");
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
      context: makeContext({ prs: [{ owner: "acme", repo: "widgets", number: 7 }] }),
      github: makeGithub(),
      linear,
      gitEnv: {},
    });

    expect(linear.moveTicketToInReview).toHaveBeenCalledWith("DEN-1");
    expect(result).toEqual({ status: "done", prs: [{ owner: "acme", repo: "widgets", number: 7 }] });
  });

  it("sends a slack 'opened' notification on a new PR after wrote_code", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    const slack = { notifyPullRequest: vi.fn().mockResolvedValue(undefined) };
    const github = makeGithub();
    github.getDefaultBranch.mockResolvedValue("main");
    github.createPullRequest.mockResolvedValue({ owner: "acme", repo: "widgets", number: 42 });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "feat: ship",
        prTitle: "feat: ship",
        prBody: "body",
      });
    });

    await runPiWorker({ context: makeContext(), github, linear, slack, gitEnv: {} });

    expect(slack.notifyPullRequest).toHaveBeenCalledWith({
      kind: "opened",
      pr: { owner: "acme", repo: "widgets", number: 42 },
      title: "feat: ship",
      url: "https://github.com/acme/widgets/pull/42",
      ticketId: "DEN-1",
      ticketUrl: "https://linear.app/bluebear/issue/DEN-1/build-thing",
    });
  });

  it("sends a slack 'updated' notification when wrote_code runs on an existing PR", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    const slack = { notifyPullRequest: vi.fn().mockResolvedValue(undefined) };
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix typo",
        prBody: "body",
      });
    });

    await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [makePullRequestContext()],
      }),
      github: makeGithub(),
      linear,
      slack,
      gitEnv: {},
    });

    expect(slack.notifyPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "updated",
        pr: { owner: "acme", repo: "widgets", number: 7 },
        url: "https://github.com/acme/widgets/pull/7",
        ticketId: "DEN-1",
      }),
    );
  });

  it("does not require a slack integration to be provided", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({ prs: [{ owner: "acme", repo: "widgets", number: 7 }] }),
      github: makeGithub(),
      linear,
      gitEnv: {},
    });

    expect(result).toEqual({ status: "done", prs: [{ owner: "acme", repo: "widgets", number: 7 }] });
  });

  it("sends a slack 'opened' notification on a new PR after wrote_code", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    const slack = { notifyPullRequest: vi.fn().mockResolvedValue(undefined) };
    const github = makeGithub();
    github.getDefaultBranch.mockResolvedValue("main");
    github.createPullRequest.mockResolvedValue({ owner: "acme", repo: "widgets", number: 42 });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "feat: ship",
        prTitle: "feat: ship",
        prBody: "body",
      });
    });

    await runPiWorker({ context: makeContext(), github, linear, slack, gitEnv: {} });

    expect(slack.notifyPullRequest).toHaveBeenCalledWith({
      kind: "opened",
      pr: { owner: "acme", repo: "widgets", number: 42 },
      title: "feat: ship",
      url: "https://github.com/acme/widgets/pull/42",
      ticketId: "DEN-1",
      ticketUrl: "https://linear.app/bluebear/issue/DEN-1/build-thing",
    });
  });

  it("does not send a slack notification on iteration when only bot comments triggered the dispatch", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    const slack = { notifyPullRequest: vi.fn().mockResolvedValue(undefined) };
    const botPrContext = makePullRequestContext();
    botPrContext.reviewThreads[0]!.comments[0]!.author = "cursor[bot]";
    botPrContext.unresolvedReviewThreads = botPrContext.reviewThreads;
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "body",
      });
    });

    await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [botPrContext],
      }),
      github: makeGithub(),
      linear,
      slack,
      gitEnv: {},
    });

    expect(slack.notifyPullRequest).not.toHaveBeenCalled();
  });

  it("sends a slack notification on iteration when at least one unresolved thread has a human comment", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    const slack = { notifyPullRequest: vi.fn().mockResolvedValue(undefined) };
    const mixedPrContext = makePullRequestContext();
    // First thread is a bot; add a second human-authored thread.
    mixedPrContext.reviewThreads[0]!.comments[0]!.author = "baloo[bot]";
    mixedPrContext.reviewThreads.push({
      id: "thread-2",
      isResolved: false,
      path: "src/file.ts",
      line: 2,
      comments: [
        {
          id: "comment-2",
          databaseId: 124,
          body: "Real human concern.",
          author: "alice",
          url: "https://github.com/acme/widgets/pull/7#discussion_r124",
          createdAt: "2026-06-09T00:00:00Z",
          updatedAt: "2026-06-09T00:00:00Z",
          path: "src/file.ts",
          line: 2,
          originalLine: 2,
          diffHunk: "@@",
        },
      ],
    });
    mixedPrContext.unresolvedReviewThreads = mixedPrContext.reviewThreads;
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "wrote_code", {
        repoRoot: "/tmp/workspace/blueden",
        commitMessage: "fix",
        prTitle: "fix",
        prBody: "body",
      });
    });

    await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [mixedPrContext],
      }),
      github: makeGithub(),
      linear,
      slack,
      gitEnv: {},
    });

    expect(slack.notifyPullRequest).toHaveBeenCalledTimes(1);
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
    expect(result).toEqual({ status: "pending", prs: [] });
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
    prs: [],
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
        priority: 0,
      },
      comments: [],
    },
    pullRequests: [],
    cloneScript: {
      scriptPath: "/tmp/script.sh",
      workspaceDir: "/tmp/workspace",
      stdout: "",
      stderr: "",
      netrcDir,
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
  const reviewThreads = [
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
  ];
  return {
    pullRequest: { number: 7 },
    headSha: "abc123def456",
    failedCheckRuns: [],
    failedStatuses: [],
    unresolvedReviewThreads: reviewThreads.filter((thread) => !thread.isResolved),
    reviewThreads,
  };
}
