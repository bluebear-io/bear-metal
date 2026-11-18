import { mkdir, rm } from "node:fs/promises";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { customizeAndResolve } from "../customization/task.js";
import { narrowTools } from "../customization/tools.js";
import { DEFAULT_MAX_DURATION_MS, type BearMetalConfig, type Task } from "../customization/types.js";
import type { ApiTaskOutcome, DbClient } from "../db/client.js";
import type { ApiTaskRecord, ApiTaskResult, ApiTaskUsage } from "../task-api/request.js";
import { outputSchemaErrors } from "../task-api/request.js";
import { createLogger } from "../shared/index.js";
import { runWorkspaceBuilder, workspaceForApiTask } from "./clone.js";
import { resolveSessionModel } from "./model.js";
import { createAgentGatewayTools } from "./pi.js";
import { createPiSessionRuntime, disposePiSessionRuntime } from "./pi-runtime.js";
import { freshTokens } from "./token-budget.js";
import { AgentTraceWriter, redactTraceText, traceJson } from "./trace.js";
import type { WorkerGitHub } from "./types.js";
import { untilStopped } from "./until-stopped.js";
import { createWorkspaceGuardedTools } from "./workspace-guard.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:api-task",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

// submit_result ends the task, so a profile's tool list never removes it.
const ALWAYS_KEPT = new Set(["submit_result"]);
// A task without a ticket never changes the repository, whatever its profile allows.
const CHANGE_TOOLS = new Set(["edit", "write"]);
/** Dispatching a workflow can change the repository through CI. */
const WRITE_GATEWAY_TOOLS = new Set(["github_dispatch"]);
// The clone's credentials are removed before the agent starts, so git in bash cannot push.
const READ_ONLY_GIT_ENV: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };

type StopReason = "timeout" | "budget" | "canceled";

function apiCustomizationTask(task: ApiTaskRecord): Task {
  if (!task.request.repository) throw new Error(`API task ${task.id} has no repository`);
  const [owner, name] = task.request.repository.split("/") as [string, string];
  return Object.freeze({
    id: task.id,
    type: "api",
    request: task.request.instruction,
    profile: task.request.profile,
    repositories: Object.freeze([Object.freeze({ owner, name })]),
  });
}

function taskPrompt(task: ApiTaskRecord, repoRoot: string): string {
  const request = task.request;
  return [
    `Repository: ${request.repository}, checked out at ${repoRoot}.`,
    "You cannot change the repository or open pull requests. Report what you found through submit_result.",
    "End by calling submit_result exactly once.",
    "",
    "## Instruction",
    request.instruction,
    ...(request.inputs ? ["", "## Inputs", "```json", JSON.stringify(request.inputs, null, 2), "```"] : []),
    ...(request.outputSchema ? ["", "## Result schema", "submit_result's `result` must match this JSON schema:", "```json", JSON.stringify(request.outputSchema, null, 2), "```"] : []),
  ].join("\n");
}

/**
 * Runs one task API task without a ticket to its outcome. Stops itself at the request's deadline or token budget, and when
 * `canceled()` turns true. Never throws for agent failures.
 */
export async function runApiTaskAgent(input: {
  task: ApiTaskRecord;
  config: BearMetalConfig;
  db: DbClient;
  github: WorkerGitHub;
  gateway?: AgentToolGatewayLike;
  canceled: () => Promise<boolean>;
  cancelPollMs?: number;
}): Promise<ApiTaskOutcome> {
  const { task } = input;
  const request = task.request;
  const workspaceDir = workspaceForApiTask(task.id);
  const traceWriter = new AgentTraceWriter(input.db, task.id);
  let submitted: { message: string; result: Record<string, unknown> | null } | undefined;
  let usage: ApiTaskUsage | null = null;
  let stopReason: StopReason | null = null;
  let error: string | null = null;
  let netrcDir: string | undefined;
  const stopController = new AbortController();
  const stop = (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    stopController.abort(new Error(`Task stopped: ${reason}`));
  };
  const deadlineMs = Date.parse(request.deadline) - Date.now();
  const deadlineTimer = setTimeout(() => stop("timeout"), Math.max(deadlineMs, 0));
  let durationTimer: NodeJS.Timeout | undefined;
  let maxTokens = request.maxTokens;
  const cancelTimer = setInterval(() => {
    void input.canceled().then((canceled) => { if (canceled) stop("canceled"); })
      .catch((err) => logger.error({ err, taskId: task.id }, "API task cancel check failed"));
  }, input.cancelPollMs ?? 5_000);
  try {
    const { customization, llm } = await customizeAndResolve(input.config, apiCustomizationTask(task));
    await input.db.setAgentRunModel(task.id, llm.provider, llm.model);
    maxTokens = Math.min(request.maxTokens, customization.limits?.maxTokens ?? request.maxTokens);
    const maxDurationMs = customization.limits?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    if (maxDurationMs < deadlineMs) durationTimer = setTimeout(() => stop("timeout"), maxDurationMs);

    await mkdir(workspaceDir, { recursive: true });
    const built = await runWorkspaceBuilder({
      workspaceDir, githubToken: await input.github.getInstallationToken(), buildWorkspace: customization.buildWorkspace, signal: stopController.signal,
    });
    netrcDir = built.netrcDir;
    await rm(built.netrcDir, { recursive: true, force: true });
    const workspaceRoot = built.agentWorkdir;

    const allTools: ToolDefinition[] = [
      ...createWorkspaceGuardedTools(workspaceRoot, READ_ONLY_GIT_ENV).filter((tool) => !CHANGE_TOOLS.has(tool.name)),
      submitResultTool(),
      ...(input.gateway ? createAgentGatewayTools(input.gateway, { taskId: task.id, runId: task.id, workspaceRoot }, stopController.signal)
        .filter((tool) => !WRITE_GATEWAY_TOOLS.has(tool.name)) : []),
    ];
    const customTools = narrowTools(allTools, customization.tools, ALWAYS_KEPT);

    const prompt = `${customization.additionalSystemPrompt ?? ""}\n\n${taskPrompt(task, workspaceRoot)}`;
    traceWriter.record("prompt", { text: redactTraceText(prompt) });
    const modelRuntime = await ModelRuntime.create();
    if (llm.apiKey) await modelRuntime.setRuntimeApiKey(llm.provider, llm.apiKey);
    else if (llm.provider !== "amazon-bedrock") throw new Error(`Missing API key for LLM provider "${llm.provider}"`);
    const runtime = await createPiSessionRuntime({
      cwd: workspaceRoot, modelRuntime, model: resolveSessionModel(modelRuntime, llm),
      tools: customTools.map((tool) => tool.name), customTools, ownerEmail: request.owner,
    });
    const session = runtime.session;
    const pendingArgs = new Map<string, unknown>();
    const onStop = () => { void session.abort().catch((err) => logger.error({ err, taskId: task.id }, "API task session abort failed")); };
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
    try {
      await traceWriter.flush();
    } finally {
      if (netrcDir) await rm(netrcDir, { recursive: true, force: true });
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  const result: ApiTaskResult = {
    message: submitted?.message ?? null,
    result: submitted?.result ?? null,
    pullRequests: [],
    usage,
  };
  if (stopReason === "timeout") return { status: "timeout", result, error: `Deadline ${request.deadline} reached` };
  if (stopReason === "budget") return { status: "budget", result, error: `Token budget of ${maxTokens} reached` };
  if (stopReason === "canceled") return { status: "failed", result, error: "Canceled through the task API" };
  if (error) return { status: "failed", result, error };
  if (!submitted) return { status: "failed", result, error: "The agent ended without calling submit_result" };
  return { status: "succeeded", result, error: null };

  function submitResultTool(): ToolDefinition {
    return defineTool({
      name: "submit_result",
      label: "Submit result",
      description: "Submit the task's result. Call it exactly once.",
      parameters: Type.Object({
        message: Type.String({ minLength: 1, description: "A short human-readable summary of what you did and found." }),
        result: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The structured result; must match the result schema when one is given." })),
      }),
      execute: async (_id, params) => {
        if (submitted) throw new Error("submit_result was already called");
        if (request.outputSchema) {
          const errors = outputSchemaErrors(request.outputSchema, params.result);
          if (errors.length > 0) throw new Error(`result does not match the result schema: ${errors.join("; ")}`);
        }
        submitted = { message: params.message, result: params.result ?? null };
        return { content: [{ type: "text", text: "Result recorded. Stop now." }], details: {} };
      },
    });
  }
}
