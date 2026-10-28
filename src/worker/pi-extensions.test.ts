import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInputContext } from "./types.js";

type TestTool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

const harness = vi.hoisted(() => ({
  agentDir: "",
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
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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

  it("hands back on the time limit when an extension session_start never settles", async () => {
    const factory: ExtensionFactory = (pi) => {
      pi.on("session_start", () => new Promise<void>(() => {}));
    };
    harness.extensionFactories = [factory];
    const linear = { commentAndHandBack: vi.fn(async () => {}), moveTicketToInReview: vi.fn(async () => {}) };

    const result = await runWorker(workspaceRoot, root, { maxWorkerTimeMs: 50, linear });

    expect(result.status).toBe("pending");
    expect(harness.events).toEqual([]);
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(linear.commentAndHandBack).toHaveBeenCalledWith("ABC-1", expect.stringContaining("time limit"));
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
  options: { maxWorkerTimeMs?: number; linear?: unknown } = {},
) {
  const { runPiWorker } = await import("./pi.js");
  return runPiWorker({
    context: makeContext(workspaceRoot, workspaceDir),
    github: {} as never,
    linear: (options.linear ?? { commentAndHandBack: vi.fn(async () => {}), moveTicketToInReview: vi.fn(async () => {}) }) as never,
    gitEnv: {},
    maxWorkerTimeMs: options.maxWorkerTimeMs ?? 60_000,
    maxWorkerTokens: 1_000_000,
    llmProvider: "anthropic",
    llmApiKey: "test-key",
    llmModel: "claude-opus-4-7",
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
