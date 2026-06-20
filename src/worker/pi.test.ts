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
  push: vi.fn(async () => {}),
  getCurrentBranch: vi.fn(async () => "feature/abc-1"),
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
    push: gitMock.push,
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
    create: () => ({ find: vi.fn().mockReturnValue({}) }),
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
        id: "thread-1",
      });
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    await runPiWorker({ context, github, linear, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.prs[0],
      "thread-1",
      "Fixed.",
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
        id: "thread-1",
        text: "The current code already handles this path.",
      });
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    await runPiWorker({ context, github, linear, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

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

    const result = await runPiWorker({ context, github, linear, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

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
        id: "thread-1",
        text: "No change needed.",
      });
      // agent calls no finish tool — disagree-only, no code changes
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(result).toEqual({ status: "done", prs: context.prs });
  });

  it("allows respond_to_comment_writer to be called for multiple threads without crashing", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const prContext = makePullRequestContext();
    prContext.reviewThreads.push({
      id: "thread-2",
      isResolved: false,
      path: "src/file.ts",
      line: 2,
      comments: [
        {
          id: "comment-2",
          databaseId: 124,
          body: "Another concern.",
          author: "reviewer",
          authorId: "U_reviewer" as string | null,
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
    prContext.unresolvedReviewThreads = prContext.reviewThreads;
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [prContext],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-1", text: "Question 1." });
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-2", text: "Question 2." });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

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
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "fix",
      });
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-1", text: "Blocked here." });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(result).toMatchObject({ status: "pending", prs: context.prs });
  });

  it("preserves pending decision when push_for_review is called after respond_to_comment_writer", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-1", text: "Blocked here." });
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    const result = await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(result.status).toBe("pending");
    expect(result.prs).toEqual(context.prs);
  });

  it("routes review-thread tools to the correct PR when multiple PRs are in context", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const prA = makePullRequestContext();
    const prB = makePullRequestContext();
    // Give PR B distinct thread/issue-comment ids; node ids are globally unique on GitHub.
    prB.reviewThreads[0]!.id = "thread-B1";
    prB.unresolvedReviewThreads = prB.reviewThreads;
    prB.issueComments[0]!.id = "IC_def456";
    const context = makeContext({
      state: "iteration",
      prs: [
        { owner: "acme", repo: "widgets", number: 7 },
        { owner: "acme", repo: "gadgets", number: 9 },
      ],
      pullRequests: [prA, prB],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "agree_with_github_message", { id: "thread-B1" });
      await executeTool(customTools, "respond_to_comment_writer", { threadId: "thread-1", text: "Question." });
    });

    await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.prs[1],
      "thread-B1",
      "Fixed.",
      prB.unresolvedReviewThreads,
    );
    expect(github.resolveReviewThread).toHaveBeenCalledWith("thread-B1");
    expect(github.replyToReviewThread).toHaveBeenCalledWith(
      context.prs[0],
      "thread-1",
      "Question.",
      prA.unresolvedReviewThreads,
    );
  });

  it("throws when review-thread tool is called with an unknown comment id", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    let caught: unknown;
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      try {
        await executeTool(customTools, "agree_with_github_message", { id: "thread-unknown" });
      } catch (err) {
        caught = err;
      }
    });

    await runPiWorker({ context, github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Unknown comment id/);
  });

  it("agree_with_github_message on issue comment records it in comment store without minimizing", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const commentStore = makeCommentStore();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "agree_with_github_message", {
        id: "IC_abc123",
      });
    });

    await runPiWorker({ context, github, linear: makeLinear(), commentStore, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(commentStore.markCompleted).toHaveBeenCalledWith(context.prs[0], "IC_abc123");
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
    expect(github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("disagree_with_github_message on issue comment posts PR comment and records in comment store", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const commentStore = makeCommentStore();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "disagree_with_github_message", {
        id: "IC_abc123",
        text: "This gap is not actionable because the spec explicitly defers it.",
      });
    });

    await runPiWorker({ context, github, linear: makeLinear(), commentStore, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(github.leaveComment).toHaveBeenCalledWith(
      context.prs[0],
      "This gap is not actionable because the spec explicitly defers it.",
    );
    expect(commentStore.markCompleted).toHaveBeenCalledWith(context.prs[0], "IC_abc123");
    expect(github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("mark_github_message_completed on issue comment records it in comment store without minimizing", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const commentStore = makeCommentStore();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "mark_github_message_completed", {
        id: "IC_abc123",
      });
    });

    await runPiWorker({ context, github, linear: makeLinear(), commentStore, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(commentStore.markCompleted).toHaveBeenCalledWith(context.prs[0], "IC_abc123");
    expect(github.resolveReviewThread).not.toHaveBeenCalled();
  });

  it("mark_github_message_completed on review thread resolves it without touching comment store", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    const commentStore = makeCommentStore();
    const context = makeContext({
      state: "iteration",
      prs: [{ owner: "acme", repo: "widgets", number: 7 }],
      pullRequests: [makePullRequestContext()],
    });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "mark_github_message_completed", {
        id: "thread-1",
      });
    });

    await runPiWorker({ context, github, linear: makeLinear(), commentStore, gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(github.resolveReviewThread).toHaveBeenCalledWith("thread-1");
    expect(commentStore.markCompleted).not.toHaveBeenCalled();
    expect(github.replyToReviewThread).not.toHaveBeenCalled();
  });

  it("registers respond_to_ticket_reporter and push_for_review in new task mode, not iteration tools", async () => {
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
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(registeredNames).toContain("respond_to_ticket_reporter");
    expect(registeredNames).toContain("push_for_review");
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
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(registeredNames).toContain("agree_with_github_message");
    expect(registeredNames).toContain("disagree_with_github_message");
    expect(registeredNames).toContain("respond_to_comment_writer");
    expect(registeredNames).toContain("mark_github_message_completed");
    expect(registeredNames).toContain("push_for_review");
    expect(registeredNames).not.toContain("respond_to_ticket_reporter");
  });

  it("moves the Linear ticket to In Review after writing code", async () => {
    const { runPiWorker } = await import("./pi.js");
    const linear = makeLinear();
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "fix",
      });
    });

    const result = await runPiWorker({
      context: makeContext({ prs: [{ owner: "acme", repo: "widgets", number: 7 }] }),
      github: makeGithub(),
      linear,
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(linear.moveTicketToInReview).toHaveBeenCalledWith("ABC-1");
    expect(result).toMatchObject({ status: "done", prs: [{ owner: "acme", repo: "widgets", number: 7 }] });
  });

  it("sets notifyOnComplete=true on result for a new PR after push_for_review", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    github.getDefaultBranch.mockResolvedValue("main");
    github.createPullRequest.mockResolvedValue({ owner: "acme", repo: "widgets", number: 42 });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "feat: ship",
        prBody: "body",
      });
    });

    const result = await runPiWorker({ context: makeContext(), github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(result.notifyOnComplete).toBe(true);
    expect(result.prs).toEqual([{ owner: "acme", repo: "widgets", number: 42 }]);
  });

  it("sets notifyOnComplete on iteration with unresolved human thread", async () => {
    const { runPiWorker } = await import("./pi.js");
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix typo",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [makePullRequestContext()],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result.notifyOnComplete).toBe(true);
  });

  it("sets notifyOnComplete=true for a new PR (state=new always notifies)", async () => {
    const { runPiWorker } = await import("./pi.js");
    const github = makeGithub();
    github.getDefaultBranch.mockResolvedValue("main");
    github.createPullRequest.mockResolvedValue({ owner: "acme", repo: "widgets", number: 42 });
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "feat: ship",
        prBody: "body",
      });
    });

    const result = await runPiWorker({ context: makeContext(), github, linear: makeLinear(), gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key" });

    expect(result.notifyOnComplete).toBe(true);
  });

  it("sets notifyOnComplete=true on iteration even when only bot comments triggered the dispatch", async () => {
    const { runPiWorker } = await import("./pi.js");
    const botPrContext = makePullRequestContext();
    botPrContext.reviewThreads[0]!.comments[0]!.author = "cursor[bot]";
    botPrContext.reviewThreads[0]!.comments[0]!.authorId = "BOT_cursor";
    botPrContext.unresolvedReviewThreads = botPrContext.reviewThreads;
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [botPrContext],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result.notifyOnComplete).toBe(true);
  });

  it("sets notifyOnComplete=true on iteration when at least one unresolved thread has a human comment", async () => {
    const { runPiWorker } = await import("./pi.js");
    const mixedPrContext = makePullRequestContext();
    // First thread is a bot; add a second human-authored thread.
    mixedPrContext.reviewThreads[0]!.comments[0]!.author = "baloo[bot]";
    mixedPrContext.reviewThreads[0]!.comments[0]!.authorId = "BOT_baloo";
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
          authorId: "U_alice",
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
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [mixedPrContext],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result.notifyOnComplete).toBe(true);
  });

  it("sets notifyOnComplete=true on iteration even with no unresolved review threads (e.g. CI-failure re-run)", async () => {
    const { runPiWorker } = await import("./pi.js");
    const prContext = makePullRequestContext();
    prContext.reviewThreads = [];
    prContext.unresolvedReviewThreads = [];
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [prContext],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result.notifyOnComplete).toBe(true);
  });

  it("sets notifyOnComplete=true even when bear-metal bot replied last (no [bot] suffix in GraphQL login)", async () => {
    const { runPiWorker } = await import("./pi.js");
    const ownBotPrContext = makePullRequestContext();
    // GraphQL returns the bare slug for app accounts; the node id is what
    // disambiguates a bot from a user.
    ownBotPrContext.reviewThreads[0]!.comments[0]!.author = "bear-metal-app";
    ownBotPrContext.reviewThreads[0]!.comments[0]!.authorId = "BOT_kgDOEWhZZw";
    ownBotPrContext.unresolvedReviewThreads = ownBotPrContext.reviewThreads;
    piMock.runTools.mockImplementationOnce(async (customTools: TestTool[]) => {
      await executeTool(customTools, "push_for_review", {
        repoRoot: "/tmp/workspace/agent",
        prTitle: "fix",
        prBody: "body",
      });
    });

    const result = await runPiWorker({
      context: makeContext({
        state: "iteration",
        prs: [{ owner: "acme", repo: "widgets", number: 7 }],
        pullRequests: [ownBotPrContext],
      }),
      github: makeGithub(),
      linear: makeLinear(),
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(result.notifyOnComplete).toBe(true);
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
      gitEnv: {}, maxWorkerTimeMs: 7_200_000, maxWorkerTokens: 20_000_000, llmProvider: "anthropic", llmApiKey: "test-key",
    });

    expect(commentAndHandBack).toHaveBeenCalledWith("ABC-1", expect.stringContaining("Need a product decision."));
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
    ticketId: "ABC-1",
    prs: [],
    ticket: {
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
        delegate: { id: "user-1" },
        priority: 0,
      },
      comments: [],
    },
    pullRequests: [],
    cloneScript: {
      agentWorkdir: "/tmp/workspace/agent",
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
    getBotIdentity: vi.fn().mockResolvedValue({ login: "bear-metal-app[bot]", id: "bot-id", numericId: 12345 }),
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    leaveComment: vi.fn().mockResolvedValue(undefined),
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
    getUserEmail: vi.fn().mockResolvedValue(null),
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
          authorId: "U_reviewer" as string | null,
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
    issueComments: [
      {
        id: "IC_abc123",
        databaseId: 456,
        body: "Deployment complete.",
        author: "ci-bot",
        authorId: null,
        isMinimized: false,
        createdAt: "2026-06-09T00:00:00Z",
        updatedAt: "2026-06-09T00:00:00Z",
      },
    ],
    completedIssueComments: [],
    mergeable: true,
  };
}

function makeCommentStore() {
  return {
    markCompleted: vi.fn().mockResolvedValue(undefined),
    getCompleted: vi.fn().mockResolvedValue(new Set<string>()),
  };
}
