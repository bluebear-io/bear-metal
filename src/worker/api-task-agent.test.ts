import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolChoice, BearMetalConfig, Task } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import type { ApiTaskRequest } from "../task-api/request.js";
import { runApiTaskAgent } from "./api-task-agent.js";
import type { WorkerGitHub } from "./types.js";

const sessionFactory = vi.hoisted(() => vi.fn());
const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../shared/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/index.js")>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return Object.assign(Object.create(real), { error: (...a: unknown[]) => { logged.error(...a); } });
    },
  };
});
vi.mock("./pi-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pi-runtime.js")>()),
  createPiSessionRuntime: async (options: unknown) => {
    const { session, dispose } = await sessionFactory(options);
    return { session, dispose: dispose ?? (async () => {}) };
  },
}));

const profile = {
  id: "researcher", name: "Researcher", instructions: "Research it.", toolCeiling: ["repo.read"], shell: true, customerData: false,
};

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
  const github = { getInstallationToken: async () => "gh-token" } as unknown as WorkerGitHub;

  const config = (tools?: AgentToolChoice[], limits?: { maxTokens?: number; maxDurationMs?: number }): BearMetalConfig => ({
    linear: { clientId: "id", getClientSecret: () => "secret" },
    github: { appId: 1, installationId: 1, getPrivateKey: () => "key" },
    llmProviders: { anthropic: { getApiKey: () => "test-key" } },
    customizeTask: (task) => {
      customized.push(task);
      return {
        llm: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        ...(tools ? { tools } : {}),
        ...(limits ? { limits } : {}),
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
      idempotencyKey: `request-${Math.random()}`, profile, owner: "owner@example.com", repository: "acme/widgets",
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
  });
  afterEach(async () => {
    sessionFactory.mockReset();
    vi.unstubAllEnvs();
    await db.close();
    await rm(base, { recursive: true, force: true });
  });

  it("runs as the requested profile and owner without tools or credentials that change the repository", async () => {
    const task = await createTask();
    let toolNames: string[] = [];
    let ownerEmail: string | undefined;
    let askpass: unknown;
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((candidate: Tool) => candidate.name);
      ownerEmail = options.ownerEmail;
      return fakeSession(async ({ tools, cwd }) => {
        askpass = await tool(tools, "bash").execute("1", { command: "echo \"askpass=${GIT_ASKPASS:-none}\"" });
        await tool(tools, "submit_result").execute("2", { message: "Done", result: { summary: "ok" } });
      })(options);
    });
    const outcome = await run(task, { config: config(["read", "edit", "write", "bash", "commit_changes", "push_for_review"]) });
    expect(outcome).toMatchObject({ status: "succeeded", error: null });
    expect(outcome.result).toEqual({
      message: "Done", result: { summary: "ok" }, pullRequests: [],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, freshTokens: 15, provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
    });
    expect(ownerEmail).toBe("owner@example.com");
    expect(toolNames.sort()).toEqual(["bash", "read", "submit_result"]);
    expect(JSON.stringify(askpass)).toContain("askpass=none");
    expect(customized[0]).toEqual({ id: task.id, type: "api", request: "Do it", profile, repositories: [{ owner: "acme", name: "widgets" }] });
  });

  it("removes Git credentials the workspace builder left in the clone before the agent starts", async () => {
    const task = await createTask({ outputSchema: undefined });
    const leaky = config();
    const customizeTask = leaky.customizeTask;
    leaky.customizeTask = async (t) => {
      const hooks = await customizeTask(t);
      return {
        ...hooks,
        buildWorkspace: async (input) => {
          await hooks.buildWorkspace(input);
          git(input.workspacePath, "remote", "set-url", "origin", "https://x-access-token:leaked-token@github.com/acme/widgets.git");
          git(input.workspacePath, "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic leaked-header");
          git(input.workspacePath, "config", "credential.helper", "store --file=/tmp/leaked");
          git(input.workspacePath, "config", "url.https://leaked-token@github.com/.insteadOf", "https://github.com/");
          git(input.workspacePath, "config", "core.sshCommand", "ssh -i /tmp/leaked-key");
          git(input.workspacePath, "remote", "add", "ssh-mirror", "git@github.com:acme/widgets.git");
        },
      };
    };
    let seen = "";
    sessionFactory.mockImplementation(fakeSession(async ({ tools }) => {
      seen = JSON.stringify(await tool(tools, "bash").execute("1", {
        command: "git remote get-url origin; git config --list --local; echo \"ssh=$GIT_SSH_COMMAND agent=${SSH_AUTH_SOCK:-none} global=$GIT_CONFIG_GLOBAL nosystem=$GIT_CONFIG_NOSYSTEM\"",
      }));
      await tool(tools, "submit_result").execute("2", { message: "Looked" });
    }));
    expect(await run(task, { config: leaky })).toMatchObject({ status: "succeeded" });
    expect(seen).toContain("https://github.com/acme/widgets.git");
    expect(seen).not.toMatch(/leaked|extraheader|credential\.|sshcommand/i);
    expect(seen).toContain("ssh=false agent=none global=/dev/null nosystem=1");
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

  it("preserves a large structured result submitted from a workspace file", async () => {
    const findings = Array.from({ length: 5_000 }, (_, i) => ({ key: `finding:${i}`, title: `Finding ${i}`, evidence: "evidence ".repeat(20) }));
    const result = { summary: "Full collection", findings };
    const task = await createTask();
    sessionFactory.mockImplementation(fakeSession(async ({ tools, cwd }) => {
      await writeFile(join(cwd, "result.json"), JSON.stringify(result));
      await tool(tools, "submit_result").execute("1", { message: "Collected", resultFile: "result.json" });
    }));
    const outcome = await run(task);
    expect(outcome.error).toBeNull();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.result?.result).toEqual(result);
  });

  it("rejects an in-flight file submission after the task exhausts its budget", async () => {
    const task = await createTask({ maxTokens: 10 });
    sessionFactory.mockImplementation(fakeSession(async ({ tools, cwd, turnEnd }) => {
      await writeFile(join(cwd, "result.json"), JSON.stringify({ summary: "late" }));
      const pending = tool(tools, "submit_result").execute("1", { message: "Late", resultFile: "result.json" });
      turnEnd();
      await expect(pending).rejects.toThrow("Task already stopped: budget");
    }));
    const outcome = await run(task);
    expect(outcome.status).toBe("budget");
    expect(outcome.result?.result).toBeNull();
  });

  it.each(["invalid-json", "invalid-schema", "array", "outside", "symlink", "oversized", "both"])("rejects %s file submissions without completing the task", async (kind) => {
    const task = await createTask();
    let rejected = false;
    sessionFactory.mockImplementation(fakeSession(async ({ tools, cwd }) => {
      const path = join(cwd, "result.json");
      const outside = join(base, "outside.json");
      await writeFile(outside, JSON.stringify({ summary: "outside" }));
      if (kind === "symlink") await symlink(outside, path);
      else await writeFile(path, kind === "invalid-json" ? "{" : kind === "invalid-schema" ? '{"summary":42}' : kind === "array" ? "[]" : kind === "oversized" ? JSON.stringify({ summary: "x".repeat(21 * 1024 * 1024) }) : '{"summary":"ok"}');
      try {
        await tool(tools, "submit_result").execute("1", {
          message: "Collected", resultFile: kind === "outside" ? outside : "result.json",
          ...(kind === "both" ? { result: { summary: "ambiguous" } } : {}),
        });
      } catch { rejected = true; }
    }));
    const outcome = await run(task);
    expect(rejected).toBe(true);
    expect(outcome.status).toBe("failed");
    expect(outcome.result?.result).toBeNull();
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

  it("reports the budget that stopped it when the customization's limit is lower than the request's", async () => {
    const task = await createTask({ maxTokens: 1_000 });
    sessionFactory.mockImplementation(fakeSession(async ({ turnEnd, aborted }) => {
      turnEnd();
      await aborted;
    }, { input: 80, output: 30, cacheRead: 500, cacheWrite: 0 }));
    expect(await run(task, { config: config(undefined, { maxTokens: 100 }) })).toMatchObject({ status: "budget", error: "Token budget of 100 reached" });
  });

  it("keeps the read-only gateway tools but not github_dispatch", async () => {
    const task = await createTask({ outputSchema: undefined });
    let toolNames: string[] = [];
    sessionFactory.mockImplementation(async (options) => {
      toolNames = options.customTools.map((candidate: Tool) => candidate.name);
      return fakeSession(async ({ tools }) => { await tool(tools, "submit_result").execute("1", { message: "Looked" }); })(options);
    });
    const gateway = { availableTools: () => ["github_read", "github_dispatch"], execute: async () => ({ ok: true, result: null }) } as unknown as NonNullable<Parameters<typeof runApiTaskAgent>[0]["gateway"]>;
    expect(await run(task, { gateway })).toMatchObject({ status: "succeeded" });
    expect(toolNames).toContain("github_read");
    expect(toolNames).not.toContain("github_dispatch");
  });

  it("reports a failure to read token usage instead of the abort it causes", async () => {
    const task = await createTask();
    const unreadable = { get input(): number { throw new Error("stats gone"); }, output: 0, cacheRead: 0, cacheWrite: 0 };
    sessionFactory.mockImplementation(fakeSession(async ({ turnEnd, aborted }) => {
      turnEnd();
      await aborted;
      throw new Error("Request was aborted");
    }, unreadable));
    expect(await run(task)).toMatchObject({ status: "failed", error: "Cannot read token usage: Error: stats gone" });
  });

  it("disposes the session and logs the error when reading its final token usage fails", async () => {
    const task = await createTask({ outputSchema: undefined });
    const unreadable = { get input(): number { throw new Error("stats gone"); }, output: 0, cacheRead: 0, cacheWrite: 0 };
    const dispose = vi.fn(async () => {});
    sessionFactory.mockImplementation(async (options) => ({
      ...(await fakeSession(async ({ tools }) => { await tool(tools, "submit_result").execute("1", { message: "Looked" }); }, unreadable)(options)),
      dispose,
    }));
    logged.error.mockClear();
    expect(await run(task)).toMatchObject({ status: "succeeded", result: { message: "Looked" } });
    expect(dispose).toHaveBeenCalledOnce();
    expect(logged.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: "stats gone" }) }), expect.any(String));
  });

  it("stops itself at the deadline and reports timeout", async () => {
    const task = await createTask({ deadline: new Date(Date.now() + 1_500).toISOString() });
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    expect(await run(task)).toMatchObject({ status: "timeout" });
  });

  it("names the customization's time limit when it, not the request deadline, stops the task", async () => {
    const task = await createTask();
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    expect(await run(task, { config: config(undefined, { maxDurationMs: 300 }) })).toMatchObject({ status: "timeout", error: "Time limit of 300 ms reached" });
  });

  it("ends the session once a valid result is submitted, so a later limit cannot relabel it", async () => {
    const task = await createTask({ outputSchema: undefined, deadline: new Date(Date.now() + 1_500).toISOString() });
    sessionFactory.mockImplementation(fakeSession(async ({ tools, aborted }) => {
      await tool(tools, "submit_result").execute("1", { message: "Done" });
      await aborted;
    }));
    expect(await run(task)).toMatchObject({ status: "succeeded", error: null, result: { message: "Done" } });
  });

  it("logs a failure that happens after the task already stopped", async () => {
    const task = await createTask({ deadline: new Date(Date.now() + 1_000).toISOString() });
    vi.spyOn(db, "setAgentRunUsage").mockRejectedValueOnce(new Error("database down"));
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    logged.error.mockClear();
    expect(await run(task)).toMatchObject({ status: "timeout" });
    expect(logged.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: "database down" }), taskId: task.id }), expect.any(String));
  });

  it("stops when the task is canceled", async () => {
    const task = await createTask();
    sessionFactory.mockImplementation(fakeSession(async ({ aborted }) => { await aborted; }));
    let canceled = false;
    setTimeout(() => { canceled = true; }, 50);
    expect(await run(task, { canceled: async () => canceled })).toMatchObject({ status: "failed", error: "Canceled through the task API" });
  });
});
