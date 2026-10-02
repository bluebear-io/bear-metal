import { rm } from "node:fs/promises";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { customizeAndResolve } from "../customization/task.js";
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOKENS, type BearMetalConfig, type Task } from "../customization/types.js";
import type { DbClient } from "../db/client.js";
import { runWorkspaceBuilder, workspaceForResearchTask } from "./clone.js";
import { CoordinatorWorkspaceCache } from "./coordinator-workspace.js";
import { createAgentGatewayTools } from "./pi.js";
import { AgentTraceWriter, redactTraceText, traceJson } from "./trace.js";
import { createWorkspaceGuardedTools } from "./workspace-guard.js";

const coordinatorWorkspaces = new WeakMap<BearMetalConfig, CoordinatorWorkspaceCache>();

function coordinatorWorkspaceFor(config: BearMetalConfig): CoordinatorWorkspaceCache {
  let cache = coordinatorWorkspaces.get(config);
  if (!cache) {
    cache = new CoordinatorWorkspaceCache();
    coordinatorWorkspaces.set(config, cache);
  }
  return cache;
}

export async function runSlackAgent(input: {
  task: Task;
  prompt: string;
  config: BearMetalConfig;
  db: DbClient;
  tools: ToolDefinition[];
  validateOutcome?: () => Promise<void>;
  stopRequested?: () => boolean;
  gateway?: AgentToolGatewayLike;
  githubToken?: string;
  getGithubToken?: () => Promise<string>;
}): Promise<void> {
  if (input.task.type === "coding") throw new Error("Slack agent cannot execute a coding task");
  const workspaceDir = input.task.type === "research"
    ? workspaceForResearchTask(input.task.id)
    : undefined;
  const traceWriter = new AgentTraceWriter(input.db, input.task.id);
  let netrcDir: string | undefined;
  let coordinatorLease: Awaited<ReturnType<CoordinatorWorkspaceCache["acquire"]>> | undefined;
  let agentWorkdir = workspaceDir ?? "";
  let runError: string | null = null;
  let runStarted = false;
  try {
    await input.db.startAgentRun(input.task, null, null);
    runStarted = true;
    const { customization, llm } = await customizeAndResolve(input.config, input.task);
    await input.db.setAgentRunModel(input.task.id, llm.provider, llm.model);
    if (input.task.type === "research") {
      if (!input.githubToken) throw new Error("Research task requires a GitHub installation token for buildWorkspace");
      if (!workspaceDir) throw new Error("Research workspace path is missing");
      const built = await runWorkspaceBuilder({
        workspaceDir,
        githubToken: input.githubToken,
        buildWorkspace: customization.buildWorkspace,
      });
      agentWorkdir = built.agentWorkdir;
      netrcDir = built.netrcDir;
    } else {
      if (!input.getGithubToken) throw new Error("Coordinator requires a GitHub installation token provider");
      coordinatorLease = await coordinatorWorkspaceFor(input.config).acquire(customization.buildWorkspace, input.getGithubToken);
      agentWorkdir = coordinatorLease.agentWorkdir;
    }
    const repositoryContext = coordinatorLease
      ? `Repository root: ${agentWorkdir}\nRead the relevant source before identifying components or grouping requests. The read, ls, grep, and find tools can access the checkout; no file writes are allowed.\n\n## AGENTS.md\n${coordinatorLease.agentsMd}\n\n`
      : "";
    const prompt = `${customization.additionalSystemPrompt ?? ""}\n\n${repositoryContext}${input.prompt}`;
    traceWriter.record("prompt", { text: redactTraceText(prompt) });
    const authStorage = AuthStorage.create();
    if (llm.apiKey) authStorage.setRuntimeApiKey(llm.provider, llm.apiKey);
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(llm.provider, llm.model);
    if (!model) throw new Error(`No model found for ${llm.provider}/${llm.model}`);
    const gatewayTools = input.gateway
      ? createAgentGatewayTools(input.gateway, { taskId: input.task.id, runId: input.task.id, workspaceRoot: agentWorkdir })
        .filter((tool) => ["github_read", "linear_read", "slack_read", "web_get"].includes(tool.name))
      : [];
    const fileTools = createWorkspaceGuardedTools(agentWorkdir).filter((tool) => ["read", "grep", "find", "ls"].includes(tool.name));
    const customTools = [...input.tools, ...gatewayTools, ...fileTools];
    const { session } = await createAgentSession({
      cwd: agentWorkdir,
      authStorage,
      modelRegistry,
      model,
      sessionManager: SessionManager.inMemory(),
      tools: customTools.map((tool) => tool.name),
      customTools,
    });
    let limitError: Error | null = null;
    let stopPromise: Promise<void> | undefined;
    let stopError: Error | null = null;
    const pendingArgs = new Map<string, unknown>();
    const abort = (reason: string) => {
      if (limitError) return;
      limitError = new Error(reason);
      void session.abort().catch((err) => { limitError = new Error(`Slack agent abort failed: ${String(err)}`); });
    };
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
        if (input.stopRequested?.() && !stopPromise) {
          stopPromise = session.abort().catch((err) => { stopError = new Error(`Slack agent deferral abort failed: ${String(err)}`); });
        }
      } else if (event.type === "turn_end" && event.message.role === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) traceWriter.record("assistant_text", { text: redactTraceText(block.text) });
          if (block.type === "thinking" && block.thinking) traceWriter.record("thinking", { text: redactTraceText(block.thinking), redacted: block.redacted === true });
        }
      }
      if (event.type !== "turn_end") return;
      try {
        const stats = session.getSessionStats();
        const used = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
        if (used >= (customization.limits?.maxTokens ?? DEFAULT_MAX_TOKENS)) abort("Slack agent token limit reached");
      } catch (err) {
        abort(`Cannot read Slack agent token usage: ${String(err)}`);
      }
    });
    const timeout = setTimeout(() => abort("Slack agent time limit reached"), customization.limits?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
    try {
      await session.prompt(prompt);
      await stopPromise;
      if (stopError) throw stopError;
      const stats = session.getSessionStats();
      await input.db.setAgentRunUsage(input.task.id, stats.tokens.input, stats.tokens.output);
      if (limitError) throw limitError;
      await input.validateOutcome?.();
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }
  } catch (err) {
    runError = String(err);
    throw err;
  } finally {
    try {
      await traceWriter.flush();
    } catch (err) {
      runError = String(err);
      throw err;
    } finally {
      try {
        if (runStarted) await input.db.finishAgentRun(input.task.id, runError, runError === null && input.stopRequested?.() ? "deferred" : undefined);
      } finally {
        if (netrcDir) await rm(netrcDir, { recursive: true, force: true });
        if (coordinatorLease) await coordinatorLease.release();
        if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
      }
    }
  }
}
