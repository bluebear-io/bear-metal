import { rm } from "node:fs/promises";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { customizeAndResolve } from "../customization/task.js";
import { narrowTools } from "../customization/tools.js";
import type { BearMetalConfig, Task } from "../customization/types.js";
import type { DbClient } from "../db/client.js";
import type { FactoryArtifactStore } from "../factory/artifacts.js";
import { diffSinceBase, prepareScratchCheckout, pushScratch } from "../factory/scratch-git.js";
import {
  outputSchemaErrors,
  type FactoryCheck, type FactoryEffect, type FactoryTaskRecord, type FactoryTaskResult, type FactoryTaskTerminalStatus, type FactoryUsage,
} from "../factory/task.js";
import { createLogger } from "../shared/index.js";
import { runWorkspaceBuilder, workspaceForFactoryTask } from "./clone.js";
import { resolveSessionModel } from "./model.js";
import { createAgentGatewayTools } from "./pi.js";
import { createPiSessionRuntime, disposePiSessionRuntime } from "./pi-runtime.js";
import { freshTokens } from "./token-budget.js";
import { AgentTraceWriter, redactTraceText, traceJson } from "./trace.js";
import { untilStopped } from "./until-stopped.js";
import { createWorkspaceGuardedTools } from "./workspace-guard.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:factory-agent",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

const WORKSPACE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"];
const GATEWAY_TOOLS = ["github_read", "linear_read", "slack_read", "web_get"];
// submit_result ends the task, so a role's tool list never removes it.
const ALWAYS_KEPT = new Set(["submit_result"]);

export type FactoryRunOutcome = {
  status: Exclude<FactoryTaskTerminalStatus, "canceled" | "superseded">;
  result: FactoryTaskResult | null;
  error: string | null;
};

type StopReason = "timeout" | "budget" | "canceled";

export function factoryCustomizationTask(task: FactoryTaskRecord): Task {
  const request = task.request;
  const [owner, name] = request.repository.split("/") as [string, string];
  return Object.freeze({
    id: task.id,
    type: "factory",
    request: request.instruction,
    labels: Object.freeze(["Factory"]),
    repositories: Object.freeze([Object.freeze({ owner, name })]),
    factory: Object.freeze({
      role: request.role,
      grants: Object.freeze([...request.grants]),
      runId: request.runId,
      repository: Object.freeze({ owner, name }),
      baseSha: request.baseSha,
      scratchBranch: request.scratchBranch ?? null,
      ownerEmail: request.owner,
    }),
  }) as Task;
}

function factoryPrompt(task: FactoryTaskRecord, canPush: boolean): string {
  const request = task.request;
  return [
    "You run one step of a workflow-factory run.",
    `Repository: ${request.repository} at ${request.baseSha}, checked out at the workspace root.`,
    canPush
      ? `Your changes reach later steps only through push_scratch, which commits them and pushes to ${request.scratchBranch}. Push before you submit the result.`
      : "This step is read-only: you cannot commit or push.",
    "You never comment, post or push anywhere else. List any comment, post, merge or other outward action the step needs as a requested effect in submit_result; the factory decides whether to perform it.",
    "End by calling submit_result exactly once.",
    "",
    "## Instruction",
    request.instruction,
    ...(request.inputs ? ["", "## Inputs", "```json", JSON.stringify(request.inputs, null, 2), "```"] : []),
    ...(request.outputSchema ? ["", "## Result schema", "submit_result's `result` must match this JSON schema:", "```json", JSON.stringify(request.outputSchema, null, 2), "```"] : []),
  ].join("\n");
}

/**
 * Runs one factory task to its outcome. Stops itself at the request's deadline or token budget, and when
 * `canceled()` turns true. Never throws for agent failures; throws only when the outcome cannot be recorded.
 */
export async function runFactoryAgent(input: {
  task: FactoryTaskRecord;
  config: BearMetalConfig;
  db: DbClient;
  artifacts: FactoryArtifactStore;
  getGithubToken: () => Promise<string>;
  gateway?: AgentToolGatewayLike;
  canceled: () => Promise<boolean>;
  cancelPollMs?: number;
}): Promise<FactoryRunOutcome> {
  const { task } = input;
  const request = task.request;
  const workspaceDir = workspaceForFactoryTask(task.id);
  const traceWriter = new AgentTraceWriter(input.db, task.id);
  let repoRoot: string | undefined;
  let submitted: { message: string; result: Record<string, unknown> | null; checks: FactoryCheck[]; effects: FactoryEffect[] } | undefined;
  let scratch: FactoryTaskResult["scratch"] = null;
  let usage: FactoryUsage | null = null;
  let stopReason: StopReason | null = null;
  let error: string | null = null;
  let transcript: string | null = null;
  const stopController = new AbortController();
  const stop = (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    stopController.abort(new Error(`Factory task stopped: ${reason}`));
  };
  const deadlineMs = Date.parse(request.deadline) - Date.now();
  const deadlineTimer = setTimeout(() => stop("timeout"), Math.max(deadlineMs, 0));
  let durationTimer: NodeJS.Timeout | undefined;
  const cancelTimer = setInterval(() => {
    void input.canceled().then((canceled) => { if (canceled) stop("canceled"); })
      .catch((err) => logger.error({ err, taskId: task.id }, "factory cancel check failed"));
  }, input.cancelPollMs ?? 5_000);
  try {
    const { customization, llm } = await customizeAndResolve(input.config, factoryCustomizationTask(task));
    await input.db.setAgentRunModel(task.id, llm.provider, llm.model);
    const maxTokens = Math.min(request.maxTokens, customization.limits?.maxTokens ?? request.maxTokens);
    if (customization.limits?.maxDurationMs !== undefined && customization.limits.maxDurationMs < deadlineMs) {
      durationTimer = setTimeout(() => stop("timeout"), customization.limits.maxDurationMs);
    }
    const built = await runWorkspaceBuilder({
      workspaceDir, githubToken: await input.getGithubToken(), buildWorkspace: customization.buildWorkspace, signal: stopController.signal,
    });
    // The builder's credential files would be readable from bash; factory pushes get their own short-lived token.
    await rm(built.netrcDir, { recursive: true, force: true });
    repoRoot = built.agentWorkdir;
    await prepareScratchCheckout(repoRoot, { repository: request.repository, baseSha: request.baseSha, scratchBranch: request.scratchBranch ?? null });
    const agentWorkdir = repoRoot;

    const allowed = customization.tools;
    const canPush = Boolean(request.scratchBranch) && (allowed === undefined || allowed.includes("push_scratch"));
    const tools: ToolDefinition[] = [submitResultTool(), ...(canPush ? [pushScratchTool()] : [])];
    const gatewayTools = input.gateway
      ? narrowTools(createAgentGatewayTools(input.gateway, { taskId: task.id, runId: task.id, workspaceRoot: agentWorkdir })
        .filter((tool) => GATEWAY_TOOLS.includes(tool.name)), allowed)
      : [];
    // No git credentials in the environment: bash cannot push, whatever command it runs.
    const fileTools = narrowTools(createWorkspaceGuardedTools(agentWorkdir).filter((tool) => WORKSPACE_TOOLS.includes(tool.name)), allowed);
    const customTools = [...tools, ...gatewayTools, ...fileTools];

    const prompt = `${customization.additionalSystemPrompt ?? ""}\n\n${factoryPrompt(task, canPush)}`;
    traceWriter.record("prompt", { text: redactTraceText(prompt) });
    const modelRuntime = await ModelRuntime.create();
    if (llm.apiKey) await modelRuntime.setRuntimeApiKey(llm.provider, llm.apiKey);
    const runtime = await createPiSessionRuntime({
      cwd: agentWorkdir, modelRuntime, model: resolveSessionModel(modelRuntime, llm),
      tools: customTools.map((tool) => tool.name), customTools, ownerEmail: request.owner,
    });
    const session = runtime.session;
    const pendingArgs = new Map<string, unknown>();
    const onStop = () => { void session.abort().catch((err) => logger.error({ err, taskId: task.id }, "factory session abort failed")); };
    stopController.signal.addEventListener("abort", onStop, { once: true });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        pendingArgs.set(event.toolCallId, event.args);
      } else if (event.type === "tool_execution_end") {
        traceWriter.record("tool_call", {
          toolCallId: event.toolCallId, toolName: event.toolName,
          argsJson: traceJson(pendingArgs.get(event.toolCallId)),
          resultText: traceJson(event.result), resultStatus: event.isError ? "error" : "ok",
        });
        pendingArgs.delete(event.toolCallId);
      } else if (event.type === "turn_end") {
        if (event.message.role === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) traceWriter.record("assistant_text", { text: redactTraceText(block.text) });
          }
        }
        try {
          if (freshTokens(session.getSessionStats().tokens) >= maxTokens) stop("budget");
        } catch (err) {
          error = `Cannot read token usage: ${String(err)}`;
          onStop();
        }
      }
    });
    try {
      await untilStopped(
        session.bindExtensions({ onError: (extensionError) => logger.error({ ...extensionError, taskId: task.id }, "pi extension error") }),
        stopController.signal,
        (outcome) => logger.warn({ outcome: outcome.status, taskId: task.id }, "pi extension binding settled after stop"),
      );
      if (!stopReason) await session.prompt(prompt);
    } finally {
      unsubscribe();
      stopController.signal.removeEventListener("abort", onStop);
      const tokens = session.getSessionStats().tokens;
      usage = {
        inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
        freshTokens: freshTokens(tokens),
      };
      await input.db.setAgentRunUsage(task.id, tokens.input, tokens.output);
      transcript = session.messages.map((message) => redactTraceText(JSON.stringify(message))).join("\n");
      await disposePiSessionRuntime(runtime, ({ error: disposeError, settledAfterGrace }) => {
        logger.error({ error: disposeError, settledAfterGrace, taskId: task.id }, "pi runtime dispose failed");
      });
    }
  } catch (err) {
    if (!stopReason) error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(durationTimer);
    clearInterval(cancelTimer);
  }

  const artifacts: FactoryTaskResult["artifacts"] = [];
  try {
    await traceWriter.flush();
    if (transcript !== null) artifacts.push({ name: "transcript.jsonl", key: await input.artifacts.put(task.id, "transcript.jsonl", transcript, "application/x-ndjson") });
    if (repoRoot) {
      const diff = await diffSinceBase(repoRoot, request.baseSha);
      if (diff) artifacts.push({ name: "diff.patch", key: await input.artifacts.put(task.id, "diff.patch", diff, "text/x-diff") });
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }

  const result: FactoryTaskResult = {
    message: submitted?.message ?? null,
    result: submitted?.result ?? null,
    checks: submitted?.checks ?? [],
    effects: submitted?.effects ?? [],
    scratch, usage, artifacts,
  };
  if (stopReason === "timeout" || stopReason === "budget") {
    return { status: stopReason, result, error: stopReason === "timeout" ? `Deadline ${request.deadline} reached` : `Token budget of ${maxTokensLabel(request.maxTokens)} reached` };
  }
  if (stopReason === "canceled") return { status: "failed", result, error: "Canceled by the factory" };
  if (error) return { status: "failed", result, error };
  if (!submitted) return { status: "failed", result, error: "The agent ended without calling submit_result" };
  return { status: "succeeded", result, error: null };

  function submitResultTool(): ToolDefinition {
    return defineTool({
      name: "submit_result",
      label: "Submit step result",
      description: "Submit this step's result. Call it exactly once, after pushing any changes. Requested effects are performed by the factory, not by you.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, description: "A short human-readable summary of what you did and found." }),
        result: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The structured result; must match the result schema when one is given." })),
        checks: Type.Optional(Type.Array(Type.Object({
          name: Type.String({ minLength: 1 }),
          status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
          detail: Type.Optional(Type.String()),
        }), { maxItems: 50, description: "Checks you ran yourself, such as tests." })),
        effects: Type.Optional(Type.Array(Type.Object({ type: Type.String({ minLength: 1, description: "For example github.comment or slack.post." }) }, { additionalProperties: true }), {
          maxItems: 10, description: "Outward actions for the factory to perform after the step.",
        })),
      }),
      execute: async (_id, params) => {
        if (submitted) throw new Error("submit_result was already called");
        if (request.outputSchema) {
          const errors = outputSchemaErrors(request.outputSchema, params.result);
          if (errors.length > 0) throw new Error(`result does not match the result schema: ${errors.join("; ")}`);
        }
        submitted = {
          message: params.message,
          result: params.result ?? null,
          checks: (params.checks ?? []) as FactoryCheck[],
          effects: (params.effects ?? []) as FactoryEffect[],
        };
        return { content: [{ type: "text", text: "Result recorded. Stop now." }], details: {} };
      },
    });
  }

  function pushScratchTool(): ToolDefinition {
    return defineTool({
      name: "push_scratch",
      label: "Push to the scratch branch",
      description: `Commit all changes in the repository and push them to ${request.scratchBranch}, the only branch this step may write. Opens no pull request.`,
      parameters: Type.Object({
        message: Type.String({ minLength: 1, description: "Commit message for any uncommitted changes." }),
      }),
      execute: async (_id, params) => {
        stopController.signal.throwIfAborted();
        if (!repoRoot || !request.scratchBranch) throw new Error("This step has no scratch branch");
        const pushed = await pushScratch({
          repoRoot, repository: request.repository, baseSha: request.baseSha, branch: request.scratchBranch,
          message: params.message, token: await input.getGithubToken(),
        });
        scratch = { branch: request.scratchBranch, sha: pushed.sha, commits: pushed.commits };
        return { content: [{ type: "text", text: `Pushed ${pushed.sha} to ${request.scratchBranch}.` }], details: scratch };
      },
    });
  }
}

function maxTokensLabel(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
