import { mkdir, mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { runCommand } from "../shared/command.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInputContext } from "./types.js";

type TestTool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

const harness = vi.hoisted(() => ({
  agentDir: "",
  realPrompt: false,
  modelCalls: 0,
  extensionFactories: [] as unknown[],
  events: [] as string[],
  logError: vi.fn(),
  dispose: vi.fn(),
  bindExtensions: null as (() => Promise<void>) | null,
}));

vi.mock("../shared/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/index.js")>();
  return {
    ...actual,
    createLogger: (options: Parameters<typeof actual.createLogger>[0]) => {
      const logger = actual.createLogger(options);
      return new Proxy(logger, {
        get: (target, prop, receiver) =>
          prop === "error" ? harness.logError : Reflect.get(target, prop, receiver),
      });
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    ModelRuntime: {
      create: () => actual.ModelRuntime.create({
        authPath: join(harness.agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(harness.agentDir, "models-store.json"),
        refreshOnCreate: false,
      }),
    },
    getAgentDir: () => harness.agentDir,
    createAgentSessionServices: (options: Parameters<typeof actual.createAgentSessionServices>[0]) =>
      actual.createAgentSessionServices({
        ...options,
        resourceLoaderOptions: { extensionFactories: harness.extensionFactories as ExtensionFactory[] },
      }),
    createAgentSessionFromServices: async (options: Parameters<typeof actual.createAgentSessionFromServices>[0]) => {
      const result = await actual.createAgentSessionFromServices(options);
      const dispose = result.session.dispose.bind(result.session);
      result.session.dispose = () => {
        harness.dispose();
        dispose();
      };
      if (harness.bindExtensions) result.session.bindExtensions = harness.bindExtensions;
      if (harness.realPrompt) {
        result.session.agent.streamFunction = (model) => {
          harness.modelCalls++;
          const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id,
            content: [{ type: "text", text: "Preparation is done; implementation still needs review." },
              { type: "toolCall", id: "must-not-run", name: "write", arguments: { path: "after-limit.txt", content: "must not run" } }],
            usage: { input: 10, output: 5, cacheRead: 5000, cacheWrite: 5, totalTokens: 5020,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse", timestamp: Date.now(),
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "toolUse", message });
          return stream;
        };
        return result;
      }
      result.session.prompt = async () => {
        harness.events.push("prompt");
        const tools = options.customTools as unknown as TestTool[];
        const tool = tools.find((candidate) => candidate.name === "respond_to_ticket_reporter")!;
        await tool.execute("tool-call-id", { text: "Need a product decision." });
      };
      return result;
    },
  };
});

describe("runPiWorker extensions", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bear-metal-pi-ext-test-"));
    workspaceRoot = join(root, "agent");
    harness.agentDir = join(root, "pi-agent");
    await mkdir(workspaceRoot);
    await mkdir(harness.agentDir);
    harness.events.length = 0;
    harness.logError.mockClear();
    harness.dispose.mockReset();
    harness.bindExtensions = null;
    harness.realPrompt = false;
    harness.modelCalls = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("quiesces the real SDK before checkpointing without another request or tool mutation", async () => {
    harness.realPrompt = true;
    const remote = join(root, "remote.git");
    const gitEnv = { GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com" };
    const git = (...args: string[]) => runCommand("git", args, { cwd: workspaceRoot, env: { ...process.env, ...gitEnv }, timeoutMs: 10_000 });
    await git("init", "--bare", "-b", "main", remote);
    await git("init", "-b", "main");
    await writeFile(join(workspaceRoot, "base.txt"), "base");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("remote", "add", "origin", remote);
    await git("push", "origin", "main");
    await writeFile(join(workspaceRoot, "prepared.txt"), "finished preparation");
    harness.extensionFactories = [(pi: Parameters<ExtensionFactory>[0]) => {
      pi.on("session_shutdown", async () => { await writeFile(join(workspaceRoot, "shutdown.txt"), "quiesced"); });
    }];
    const result = await runWorker(workspaceRoot, root, { maxWorkerTokens: 20, gitEnv });
    expect(harness.modelCalls).toBe(1);
    expect(result).toMatchObject({ outcome: "interrupted", stopReason: "token_limit", usage: { cacheReadTokens: 5000 } });
    expect(result.checkpoint?.repositories).toMatchObject([{ pushed: true, error: null }]);
    await expect(stat(join(workspaceRoot, "after-limit.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git("show", "HEAD:shutdown.txt")).stdout).toBe("quiesced");
    expect(await readFile(join(workspaceRoot, "prepared.txt"), "utf8")).toBe("finished preparation");
    expect((await git("rev-list", "--count", "HEAD")).stdout.trim()).toBe("2");
  });

  it("fires session_start on loaded extensions before the prompt is sent", async () => {
    const reasons: string[] = [];
    const factory: ExtensionFactory = (pi) => {
      pi.on("session_start", (event) => {
        harness.events.push("session_start");
        reasons.push(event.reason);
      });
    };
    harness.extensionFactories = [factory];

    const result = await runWorker(workspaceRoot, root);

    expect(result.status).toBe("pending");
    expect(harness.events).toEqual(["session_start", "prompt"]);
    expect(reasons).toEqual(["startup"]);
  });

  it("fires session_shutdown on loaded extensions before the session is disposed", async () => {
    const reasons: string[] = [];
    harness.dispose.mockImplementation(() => harness.events.push("dispose"));
    const factory: ExtensionFactory = (pi) => {
      pi.on("session_start", () => { harness.events.push("session_start"); });
      pi.on("session_shutdown", (event) => {
        harness.events.push("session_shutdown");
        reasons.push(event.reason);
      });
    };
    harness.extensionFactories = [factory];

    const result = await runWorker(workspaceRoot, root);

    expect(result.status).toBe("pending");
    expect(harness.events).toEqual(["session_start", "prompt", "session_shutdown", "dispose"]);
    expect(reasons).toEqual(["quit"]);
  });

  it("logs extension errors through the worker logger", async () => {
    const factory: ExtensionFactory = (pi) => {
      pi.on("session_start", () => {
        throw new Error("extension exploded");
      });
    };
    harness.extensionFactories = [factory];

    const result = await runWorker(workspaceRoot, root);

    expect(result.status).toBe("pending");
    expect(harness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session_start", error: "extension exploded", ticketId: "ABC-1" }),
      "pi extension error",
    );
  });

  it("disposes the session when binding extensions rejects", async () => {
    harness.extensionFactories = [];
    harness.bindExtensions = async () => { throw new Error("bind failed"); };

    await expect(runWorker(workspaceRoot, root)).rejects.toThrow("bind failed");

    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.events).toEqual([]);
  });

  it("returns an interruption for durable finalization when an extension session_start never settles", async () => {
    const factory: ExtensionFactory = (pi) => {
      pi.on("session_start", () => new Promise<void>(() => {}));
    };
    harness.extensionFactories = [factory];
    const linear = { commentAndHandBack: vi.fn(async () => {}), moveTicketToInReview: vi.fn(async () => {}) };

    const result = await runWorker(workspaceRoot, root, { maxWorkerTimeMs: 50, linear });

    expect(result.status).toBe("pending");
    expect(harness.events).toEqual([]);
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "pending", outcome: "interrupted", stopReason: "timeout" });
    expect(linear.commentAndHandBack).not.toHaveBeenCalled();
  });

  it("logs a binding rejection that arrives after the time limit stopped it", async () => {
    let rejectBinding!: (error: Error) => void;
    harness.extensionFactories = [];
    harness.bindExtensions = () => new Promise<void>((_, reject) => { rejectBinding = reject; });
    const linear = { commentAndHandBack: vi.fn(async () => {}), moveTicketToInReview: vi.fn(async () => {}) };

    const result = await runWorker(workspaceRoot, root, { maxWorkerTimeMs: 50, linear });
    rejectBinding(new Error("late bind failure"));
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(result.status).toBe("pending");
    expect(harness.logError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: "late bind failure" }), ticketId: "ABC-1" }),
      "pi extension binding rejected after stop",
    );
  });
});

async function runWorker(
  workspaceRoot: string,
  workspaceDir: string,
  options: { maxWorkerTimeMs?: number; maxWorkerTokens?: number; gitEnv?: NodeJS.ProcessEnv; linear?: unknown } = {},
) {
  const { runPiWorker } = await import("./pi.js");
  return runPiWorker({
    context: makeContext(workspaceRoot, workspaceDir),
    github: { getInstallationToken: async () => "test-token" } as never,
    linear: (options.linear ?? { commentAndHandBack: vi.fn(async () => {}), moveTicketToInReview: vi.fn(async () => {}) }) as never,
    gitEnv: options.gitEnv ?? {},
    maxWorkerTimeMs: options.maxWorkerTimeMs ?? 60_000,
    maxWorkerTokens: options.maxWorkerTokens ?? 1_000_000,
    llmProvider: "anthropic",
    llmApiKey: "test-key",
    llmModel: "claude-opus-4-7", llmModelArn: null,
  });
}

function makeContext(workspaceRoot: string, workspaceDir: string): WorkerInputContext {
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
    cloneScript: { agentWorkdir: workspaceRoot, workspaceDir, stdout: "", stderr: "", netrcDir: workspaceDir },
  };
}
