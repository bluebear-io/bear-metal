import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BearMetalConfig, Task } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { FactoryArtifactStore } from "../factory/artifacts.js";
import type { FactoryTaskRequest } from "../factory/task.js";
import { runFactoryAgent } from "./factory-agent.js";

const sessionFactory = vi.hoisted(() => vi.fn());
const pushScratch = vi.hoisted(() => vi.fn());
vi.mock("./pi-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-runtime.js")>()),
  createPiSessionRuntime: async (options: unknown) => {
    const { session, dispose } = await sessionFactory(options);
    return { session, dispose: dispose ?? (async () => {}) };
  },
}));
vi.mock("../factory/scratch-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../factory/scratch-git.js")>()),
  pushScratch,
}));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Listener = (event: unknown) => void;
type Tool = { name: string; execute: (id: string, params: unknown, ...rest: unknown[]) => Promise<unknown> };

/** A session whose prompt runs `script` with the registered tools and a way to emit turn ends. */
function fakeSession(script: (ctx: { tools: Tool[]; turnEnd: () => void; aborted: Promise<void> }) => Promise<void>, tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }) {
  return async (options: { customTools: Tool[]; ownerEmail?: string }) => {
    const listeners: Listener[] = [];
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => { abort = resolve; });
    return {
      session: {
        subscribe: (listener: Listener) => { listeners.push(listener); return () => {}; },
        bindExtensions: async () => {},
        prompt: async () => script({
          tools: options.customTools,
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

describe("factory agent", () => {
  let base: string;
  let remote: string;
  let baseSha: string;
  let db: SqlDbClient;
  let customized: Task[];
  let stored: Map<string, string>;
  const artifacts: FactoryArtifactStore = {
    put: async (taskId, name, body) => { stored.set(`staging/${taskId}/${name}`, body); return `staging/${taskId}/${name}`; },
  };

  const config = (limits?: { maxTokens?: number }): BearMetalConfig => ({
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
    llmProviders: { anthropic: { getApiKey: () => "test-key" } },
    customizeTask: (task) => {
      customized.push(task);
      return {
        llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        tools: ["read", "edit", "bash", "push_scratch"],
        ...(limits ? { limits } : {}),
        buildWorkspace: async ({ workspacePath }) => {
          execFileSync("git", ["clone", "--quiet", remote, workspacePath]);
          git(workspacePath, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
        },
      };
    },
  });

  const createTask = async (overrides: Partial<FactoryTaskRequest> = {}) => {
    const request: FactoryTaskRequest = {
      idempotencyKey: `attempt-${Math.random()}:1`, runId: "run-1", owner: "owner@example.com", role: "developer",
      grants: ["repo.read", "file.edit", "git.push"], repository: "acme/widgets", baseSha,
      scratchBranch: "wf/run/run-1/dev", instruction: "Do it",
      outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
      deadline: new Date(Date.now() + 60_000).toISOString(), maxTokens: 1_000, ...overrides,
    };
    const { task } = await db.createFactoryTask(request);
    const claimed = await db.claimFactoryTask();
    if (claimed?.id !== task.id) throw new Error("claim failed");
    return claimed;
  };

  const run = (task: Awaited<ReturnType<typeof createTask>>, extra: Partial<Parameters<typeof runFactoryAgent>[0]> = {}) => runFactoryAgent({
    task, config: config(), db, artifacts, getGithubToken: async () => "gh-token", canceled: async () => false, cancelPollMs: 10, ...extra,
  });

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "bear-metal-factory-agent-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", join(base, "workspaces"));
    remote = join(base, "remote.git");
    const seed = join(base, "seed");
    execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
    await writeFile(join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "initial");
    execFileSync("git", ["clone", "--quiet", "--bare", seed, remote]);
    baseSha = git(seed, "rev-parse", "HEAD");
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    customized = [];
    stored = new Map();
    pushScratch.mockReset();
  });
  afterEach(async () => {
    sessionFactory.mockReset();
    vi.unstubAllEnvs();
    await db.close();
    await rm(base, { recursive: true, force: true });
  });

  it("runs as the requested role and owner, pushes only to the scratch branch, and returns requested effects without performing them", async () => {
    const task = await createTask();
    pushScratch.mockResolvedValue({ sha: "c".repeat(40), commits: ["c".repeat(40)] });
    let toolNames: string[] = [];
    let ownerEmail: string | undefined;
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((tool: Tool) => tool.name);
      ownerEmail = options.ownerEmail;
      return fakeSession(async ({ tools }) => {
        await tools.find((tool) => tool.name === "push_scratch")!.execute("1", { message: "Change" });
        await tools.find((tool) => tool.name === "submit_result")!.execute("2", {
          message: "Done", result: { summary: "ok" }, checks: [{ name: "tests", status: "passed" }],
          effects: [{ type: "github.comment", body: "Fixed" }],
        });
      })(options);
    });
    const outcome = await run(task);
    expect(outcome).toMatchObject({ status: "succeeded", error: null });
    expect(outcome.result).toMatchObject({
      message: "Done", result: { summary: "ok" }, checks: [{ name: "tests", status: "passed" }],
      effects: [{ type: "github.comment", body: "Fixed" }],
      scratch: { branch: "wf/run/run-1/dev", sha: "c".repeat(40), commits: ["c".repeat(40)] },
      usage: { inputTokens: 10, outputTokens: 5, freshTokens: 15 },
    });
    expect(outcome.result?.artifacts.map((artifact) => artifact.key)).toEqual([`staging/${task.id}/transcript.jsonl`]);
    expect(pushScratch).toHaveBeenCalledWith(expect.objectContaining({ branch: "wf/run/run-1/dev", repository: "acme/widgets", baseSha, token: "gh-token" }));
    expect(ownerEmail).toBe("owner@example.com");
    expect(toolNames).not.toContain("push_for_review");
    expect(toolNames).not.toContain("commit_changes");
    expect(toolNames).toEqual(expect.arrayContaining(["submit_result", "push_scratch", "read", "edit", "bash"]));
    expect(customized[0]).toMatchObject({
      type: "factory", labels: ["Factory"],
      factory: { role: "developer", grants: ["repo.read", "file.edit", "git.push"], ownerEmail: "owner@example.com", scratchBranch: "wf/run/run-1/dev" },
    });
  });

  it("offers no push to a read-only step and attaches the diff of changes it left", async () => {
    const task = await createTask({ scratchBranch: undefined, outputSchema: undefined });
    let toolNames: string[] = [];
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((tool: Tool) => tool.name);
      return fakeSession(async ({ tools }) => {
        await writeFile(join(options.cwd, "README.md"), "edited\n");
        await tools.find((tool) => tool.name === "submit_result")!.execute("1", { message: "Looked" });
      })(options);
    });
    const outcome = await run(task);
    expect(outcome.status).toBe("succeeded");
    expect(toolNames).not.toContain("push_scratch");
    expect(stored.get(`staging/${task.id}/diff.patch`)).toContain("+edited");
  });

  it("rejects a result that does not match the output schema, and fails a task that never submits", async () => {
    const task = await createTask();
    let rejection: unknown;
    sessionFactory.mockImplementation(fakeSession(async ({ tools }) => {
      await tools.find((tool) => tool.name === "submit_result")!.execute("1", { message: "Done", result: { summary: 1 } })
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
    const outcome = await run(task);
    expect(outcome).toMatchObject({ status: "timeout" });
  });

  it("stops when the factory cancels the task", async () => {
    const task = await createTask();
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    let canceled = false;
    setTimeout(() => { canceled = true; }, 50);
    const outcome = await run(task, { canceled: async () => canceled });
    expect(outcome).toMatchObject({ status: "failed", error: "Canceled by the factory" });
  });
});
