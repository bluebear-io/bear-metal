import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolChoice, BearMetalConfig, Task } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { ApiTaskRequest } from "../task-api/request.js";
import { runApiTaskAgent } from "./api-task-agent.js";
import type { WorkerGitHub } from "./types.js";

const sessionFactory = vi.hoisted(() => vi.fn());
vi.mock("./pi-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-runtime.js")>()),
  createPiSessionRuntime: async (options: unknown) => {
    const { session, dispose } = await sessionFactory(options);
    return { session, dispose: dispose ?? (async () => {}) };
  },
}));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Listener = (event: unknown) => void;
type Tool = { name: string; execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown> };

/** A session whose prompt runs `script` with the registered tools and a way to emit turn ends. */
function fakeSession(script: (ctx: { tools: Tool[]; cwd: string; turnEnd: () => void; aborted: Promise<void> }) => Promise<void>, tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }) {
  return async (options: { customTools: Tool[]; cwd: string; ownerEmail?: string }) => {
    const listeners: Listener[] = [];
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => { abort = resolve; });
    return {
      session: {
        subscribe: (listener: Listener) => { listeners.push(listener); return () => {}; },
        bindExtensions: async () => {},
        prompt: async () => script({
          tools: options.customTools,
          cwd: options.cwd,
          turnEnd: () => listeners.forEach((listener) => listener({ type: "turn_end", message: { role: "assistant", content: [] } })),
          aborted,
        }),
        abort: async () => abort(),
        getSessionStats: () => ({ tokens }),
        messages: [{ role: "user", content: "hello" }],
      },
    };
  };
}

const tool = (tools: Tool[], name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
};

describe("API task agent", () => {
  let base: string;
  let remote: string;
  let db: SqlDbClient;
  let customized: Task[];
  let created: { title: string; head: string; base: string }[];
  const github = {
    getInstallationToken: async () => "gh-token",
    getBotIdentity: async () => ({ login: "bear-metal[bot]", id: null, numericId: 1, userNumericId: 2 }),
    getDefaultBranch: async () => "main",
    createPullRequest: async (pr: { owner: string; repo: string; title: string; head: string; base: string }) => {
      created.push(pr);
      return { owner: pr.owner, repo: pr.repo, number: 42 };
    },
  } as unknown as WorkerGitHub;

  const config = (tools?: AgentToolChoice[]): BearMetalConfig => ({
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
    llmProviders: { anthropic: { getApiKey: () => "test-key" } },
    customizeTask: (task) => {
      customized.push(task);
      return {
        llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        ...(tools ? { tools } : {}),
        buildWorkspace: async ({ workspacePath }) => {
          execFileSync("git", ["clone", "--quiet", remote, workspacePath]);
          git(workspacePath, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
          git(workspacePath, "config", `url.${remote}.pushInsteadOf`, "https://github.com/acme/widgets.git");
        },
      };
    },
  });

  const createTask = async (overrides: Partial<ApiTaskRequest> = {}) => {
    const request: ApiTaskRequest = {
      idempotencyKey: `request-${Math.random()}`, profile: "developer", owner: "owner@example.com", repository: "acme/widgets",
      instruction: "Do it", outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
      deadline: new Date(Date.now() + 60_000).toISOString(), maxTokens: 1_000, ...overrides,
    };
    const { task } = await db.createApiTask(request);
    const claimed = await db.claimApiTask();
    if (claimed?.id !== task.id) throw new Error("claim failed");
    return claimed;
  };

  const run = (task: Awaited<ReturnType<typeof createTask>>, extra: Partial<Parameters<typeof runApiTaskAgent>[0]> = {}) => runApiTaskAgent({
    task, config: config(), db, github, canceled: async () => false, cancelPollMs: 10, ...extra,
  });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "bear-metal-api-task-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", join(base, "workspaces"));
    remote = join(base, "remote.git");
    const seed = join(base, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
    await writeFile(join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "initial");
    execFileSync("git", ["clone", "--quiet", "--bare", seed, remote]);
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    customized = [];
    created = [];
  });
  afterEach(async () => {
    sessionFactory.mockReset();
    vi.unstubAllEnvs();
    await db.close();
    await rm(base, { recursive: true, force: true });
  });

  it("runs as the requested profile and owner, opens a PR like a ticket task, and returns the structured result", async () => {
    const task = await createTask();
    let toolNames: string[] = [];
    let ownerEmail: string | undefined;
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((candidate: Tool) => candidate.name);
      ownerEmail = options.ownerEmail;
      return fakeSession(async ({ tools, cwd }) => {
        await writeFile(join(cwd, "README.md"), "changed\n");
        await tool(tools, "commit_changes").execute("1", { repoRoot: cwd, branch: "fix/readme", message: "Change readme" });
        await tool(tools, "push_for_review").execute("2", { repoRoot: cwd, prTitle: "Change readme", prBody: "Body" });
        await tool(tools, "submit_result").execute("3", { message: "Done", result: { summary: "ok" } });
      })(options);
    });
    const outcome = await run(task, { config: config(["read", "edit", "bash", "commit_changes", "push_for_review"]) });
    expect(outcome).toMatchObject({ status: "succeeded", error: null });
    expect(outcome.result).toEqual({
      message: "Done", result: { summary: "ok" }, pullRequests: [{ owner: "acme", repo: "widgets", number: 42 }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, freshTokens: 15 },
    });
    expect(created).toEqual([expect.objectContaining({ title: "Change readme", head: "fix/readme", base: "main" })]);
    expect(git(remote, "log", "-1", "--format=%s", "fix/readme")).toBe("Change readme");
    expect(ownerEmail).toBe("owner@example.com");
    expect(toolNames).toEqual(expect.arrayContaining(["submit_result", "commit_changes", "push_for_review", "read", "edit", "bash"]));
    expect(customized[0]).toEqual({ id: task.id, type: "api", request: "Do it", profile: "developer", repositories: [{ owner: "acme", name: "widgets" }] });
  });

  it("keeps submit_result when the profile's tools omit it", async () => {
    const task = await createTask({ outputSchema: undefined });
    let toolNames: string[] = [];
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((candidate: Tool) => candidate.name);
      return fakeSession(async ({ tools }) => { await tool(tools, "submit_result").execute("1", { message: "Looked" }); })(options);
    });
    const outcome = await run(task, { config: config(["read"]) });
    expect(outcome.status).toBe("succeeded");
    expect(toolNames.sort()).toEqual(["read", "submit_result"]);
  });

  it("rejects a result that does not match the output schema, and fails a task that never submits", async () => {
    const task = await createTask();
    let rejection: unknown;
    sessionFactory.mockImplementation(fakeSession(async ({ tools }) => {
      await tool(tools, "submit_result").execute("1", { message: "Done", result: { summary: 1 } })
        .catch((err: unknown) => { rejection = err; });
    }));
    const outcome = await run(task);
    expect(String(rejection)).toContain("does not match the result schema");
    expect(outcome).toMatchObject({ status: "failed", error: "The agent ended without calling submit_result" });
  });

  it("stops itself at the token budget and reports budget", async () => {
    const task = await createTask({ maxTokens: 100 });
    sessionFactory.mockImplementation(fakeSession(async ({ turnEnd, aborted }) => {
      turnEnd();
      await aborted;
    }, { input: 80, output: 30, cacheRead: 500, cacheWrite: 0 }));
    const outcome = await run(task);
    expect(outcome.status).toBe("budget");
    expect(outcome.result?.usage?.freshTokens).toBe(110);
  });

  it("stops itself at the deadline and reports timeout", async () => {
    const task = await createTask({ deadline: new Date(Date.now() + 1_500).toISOString() });
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    expect(await run(task)).toMatchObject({ status: "timeout" });
  });

  it("stops when the task is canceled", async () => {
    const task = await createTask();
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    let canceled = false;
    setTimeout(() => { canceled = true; }, 50);
    expect(await run(task, { canceled: async () => canceled })).toMatchObject({ status: "failed", error: "Canceled through the task API" });
  });
});
