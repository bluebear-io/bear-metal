import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../shared/command.js";
import { saveCheckpoint, type Checkpoint } from "./checkpoint.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { WorkerInputContext } from "./types.js";

const state = vi.hoisted(() => ({ calls: [] as string[], piInputs: [] as any[], tasks: [] as any[], downloadedAttachments: [] as any[], throwPi: false, interrupt: false, timeout: false }));
vi.mock("./pi.js", () => ({
  runPiWorker: async (input: any) => {
    state.calls.push("pi"); state.piInputs.push(input);
    if (state.interrupt) input.onInterrupted("token_limit");
    if (state.timeout) { input.onInterrupted("timeout"); return { status: "pending", prs: [], outcome: "interrupted", stopReason: "timeout" }; }
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
    state.calls.length = 0; state.piInputs.length = 0; state.tasks.length = 0; state.downloadedAttachments.length = 0; state.throwPi = false; state.interrupt = false; state.timeout = false;
  });
  afterEach(async () => { delete process.env.BEAR_METAL_WORKSPACE_DIR; await rm(root, { recursive: true, force: true }); });

  it("retains interrupted work even if shutdown or checkpointing throws", async () => {
    state.interrupt = true;
    state.throwPi = true;
    await expect(dispatch(makeConfig())).rejects.toThrow("pi failed");
    expect((await stat(state.piInputs[0].context.cloneScript.workspaceDir)).isDirectory()).toBe(true);
    await expect(stat(state.piInputs[0].context.cloneScript.netrcDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up timeout-interrupted workspaces", async () => {
    state.timeout = true;
    expect(await dispatch(makeConfig())).toMatchObject({ outcome: "interrupted", stopReason: "timeout" });
    await expect(stat(state.piInputs[0].context.cloneScript.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function recoveryFixture() {
    const retained = join(root, "retained");
    const remote = join(root, "remote.git");
    await mkdir(retained);
    const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (cwd: string, ...args: string[]) => runCommand("git", args, { cwd, env, timeoutMs: 10_000 });
    await git(root, "init", "--bare", remote);
    await git(retained, "init", "-b", "main");
    await writeFile(join(retained, "work.txt"), "base");
    await git(retained, "add", "."); await git(retained, "commit", "-m", "base");
    await git(retained, "remote", "add", "origin", remote); await git(retained, "push", "origin", "main");
    await writeFile(join(retained, "work.txt"), "unfinished");
    const built: string[] = [];
    const config = makeConfig();
    const customize = config.customizeTask;
    config.customizeTask = async (task) => ({ ...await customize(task), buildWorkspace: async ({ workspacePath }) => {
      built.push(workspacePath);
      await git(root, "clone", "--branch", "main", remote, workspacePath);
    } });
    return { retained, remote, env, git, built, config };
  }

  it("recovers a failed-push checkpoint after the branch is pushed manually", async () => {
    const f = await recoveryFixture();
    const hook = join(f.remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    const checkpoint = await saveCheckpoint({ workspaceRoot: f.retained, branch: "branch", ticketId: "ABC-1", gitEnv: f.env });
    await rm(hook);
    await f.git(f.retained, "push", "origin", "branch");
    await writeFile(join(f.retained, "later.txt"), "must remain uncommitted");
    const assertLease = vi.fn(async () => {});
    await dispatch(f.config, { checkpoint, assertLease });
    expect(state.piInputs).toHaveLength(1);
    expect(assertLease).toHaveBeenCalled();
    expect((await f.git(f.retained, "status", "--porcelain")).stdout).toContain("later.txt");
  });

  it("hands back a failed-commit checkpoint without retrying the commit", async () => {
    const f = await recoveryFixture();
    const hook = join(f.retained, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    const checkpoint = await saveCheckpoint({ workspaceRoot: f.retained, branch: "branch", ticketId: "ABC-1", gitEnv: f.env });
    await rm(hook);
    const result = await dispatch(f.config, { checkpoint, assertLease: async () => {} });
    expect(result).toMatchObject({ outcome: "interrupted", stopReason: "token_limit" });
    expect(state.piInputs).toHaveLength(0);
    expect((await f.git(f.retained, "status", "--porcelain")).stdout).toContain("work.txt");
  });

  it("hands back recovery failure with a redacted error and removes only the fresh workspace", async () => {
    const f = await recoveryFixture();
    const checkpoint = await saveCheckpoint({ workspaceRoot: f.retained, branch: "branch", ticketId: "ABC-1", gitEnv: f.env });
    const secret = "recovery-password";
    const assertLease = vi.fn(async () => { if (assertLease.mock.calls.length === 1) throw new Error(`fatal: unable to access https://user:${secret}@github.com/acme/repo.git`); });
    const result = await dispatch(f.config, { checkpoint, assertLease });
    expect(result).toMatchObject({ outcome: "interrupted", stopReason: "token_limit" });
    expect(result.checkpoint?.error).not.toContain(secret);
    expect(result.checkpoint?.error).toContain("REDACTED");
    expect(state.piInputs).toHaveLength(0);
    expect(await readFile(join(f.retained, "work.txt"), "utf8")).toBe("unfinished");
    await expect(stat(f.built[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards recovery after lease loss", async () => {
    const f = await recoveryFixture();
    const checkpoint = await saveCheckpoint({ workspaceRoot: f.retained, branch: "branch", ticketId: "ABC-1", gitEnv: f.env });
    await expect(dispatch(f.config, { checkpoint, assertLease: async () => { throw new Error("Lease lost"); } })).rejects.toThrow("Lease lost");
    expect(state.piInputs).toHaveLength(0);
    expect(await readFile(join(f.retained, "work.txt"), "utf8")).toBe("unfinished");
    await expect(stat(f.built[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("keeps simultaneous attempts for one ticket in separate checkouts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const built: string[] = [];
    const config = makeConfig();
    const original = config.customizeTask;
    config.customizeTask = async (task) => {
      const customization = await original(task);
      return { ...customization, buildWorkspace: async ({ workspacePath }) => {
        built.push(workspacePath);
        await writeFile(join(workspacePath, "README.md"), workspacePath);
        await gate;
      } };
    };
    const attempts = [dispatch(config), dispatch(config)];
    try {
      await vi.waitFor(() => expect(built).toHaveLength(2));
      expect(new Set(built).size).toBe(2);
    } finally {
      release();
      await Promise.all(attempts);
    }
    for (const path of built) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the entire owned task workspace on success and Pi failure", async () => {
    await dispatch(makeConfig());
    await expect(stat(state.piInputs[0].context.cloneScript.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    state.throwPi = true;
    await expect(dispatch(makeConfig())).rejects.toThrow("pi failed");
    await expect(stat(state.piInputs[1].context.cloneScript.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("applies ticket labels before In Progress when customizeTask returns ticketLabels", async () => {
    const addLabelsByName = vi.fn(async () => ["missing-label"]);
    const config = makeConfig();
    config.customizeTask = async (task) => {
      if (!("identifier" in task)) throw new Error("Expected a Linear task");
      state.tasks.push(task);
      state.calls.push("customize");
      return {
        llm: { provider: "openai", model: "gpt-test" },
        buildWorkspace: async ({ workspacePath }) => { state.calls.push("build"); await writeFile(join(workspacePath, "README.md"), "ready"); },
        ticketLabels: ["my-label", "missing-label"],
      };
    };
    const integrations = makeIntegrations();
    integrations.linear.addLabelsByName = addLabelsByName;
    await dispatch(config, { integrations, ticketIssueId: "issue-uuid", hasSlackLinkedTicket: async () => false });
    expect(addLabelsByName).toHaveBeenCalledWith("id", ["my-label", "missing-label"]);
    expect(state.calls.indexOf("in-progress")).toBeGreaterThan(state.calls.indexOf("build"));
  });

  it("preserves the pull request context when no issue comments are completed", async () => {
    const pullRequest = makePullRequestContext([{ id: "comment-1", body: "Review", author: "reviewer", authorId: null, databaseId: 1, isMinimized: false, createdAt: "created", updatedAt: "updated" }]);
    const commentStore = { getCompleted: vi.fn(async () => new Set<string>()), markCompleted: vi.fn() };
    await dispatch(makeConfig(), { state: "iteration", prs: [{ owner: "acme", repo: "repo", number: 1 }], integrations: makeIntegrations({ pullRequest, commentStore }) });

    expect(commentStore.getCompleted).toHaveBeenCalledOnce();
    expect(state.piInputs[0].context.pullRequests[0]).toBe(pullRequest);
  });
});

async function dispatch(
  config: BearMetalConfig,
  options: {
    checkpoint?: Checkpoint;
    assertLease?: () => Promise<void>;
    state?: "new" | "iteration";
    prs?: Array<{ owner: string; repo: string; number: number }>;
    integrations?: ReturnType<typeof makeIntegrations>;
    ticketIssueId?: string;
    hasSlackLinkedTicket?: (id: string) => Promise<boolean>;
  } = {},
) {
  const { dispatch } = await import("./dispatch.js");
  return dispatch({
    checkpoint: options.checkpoint,
    assertLease: options.assertLease,
    state: options.state ?? "new",
    iteration: 1,
    ticketId: "ABC-1",
    runId: "run-1",
    prs: options.prs ?? [],
    integrations: options.integrations ?? makeIntegrations(),
    agentToolGateway: { availableTools: () => [], execute: vi.fn() },
    config,
    ticketIssueId: options.ticketIssueId,
    hasSlackLinkedTicket: options.hasSlackLinkedTicket,
  });
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
      if (!("identifier" in task)) throw new Error("Expected a Linear task");
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
      getTicketContext: vi.fn(async () => options.ticket ?? makeTicketContext()), getTicketAttachments: vi.fn(async () => []), getAccessToken: vi.fn(async () => "linear-token"), moveTicketToInProgress: vi.fn(async () => { state.calls.push("in-progress"); }), moveTicketToInReview: vi.fn(), commentAndHandBack: vi.fn(), attachFileToTicket: vi.fn(), getUserEmail: vi.fn(async () => null), addLabelsByName: vi.fn(async (_id: string, _names: readonly string[]) => [] as string[]),
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
