import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { customizeAndResolve } from "../customization/task.js";
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOKENS, type BearMetalConfig, type Task } from "../customization/types.js";
import { runWorkspaceBuilder } from "./clone.js";
import { createAgentGatewayTools } from "./pi.js";
import { createWorkspaceGuardedTools } from "./workspace-guard.js";

export async function runSlackAgent(input: {
  task: Task;
  prompt: string;
  config: BearMetalConfig;
  tools: ToolDefinition[];
  gateway?: AgentToolGatewayLike;
  githubToken?: string;
}): Promise<void> {
  const { customization, llm } = await customizeAndResolve(input.config, input.task);
  const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-slack-"));
  let netrcDir: string | undefined;
  let agentWorkdir = workspaceDir;
  try {
    if (input.task.type === "research") {
      if (!input.githubToken) throw new Error("Research task requires a GitHub installation token for buildWorkspace");
      const built = await runWorkspaceBuilder({
        workspaceDir,
        githubToken: input.githubToken,
        buildWorkspace: customization.buildWorkspace,
      });
      agentWorkdir = built.agentWorkdir;
      netrcDir = built.netrcDir;
    }
    const authStorage = AuthStorage.create();
    if (llm.apiKey) authStorage.setRuntimeApiKey(llm.provider, llm.apiKey);
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(llm.provider, llm.model);
    if (!model) throw new Error(`No model found for ${llm.provider}/${llm.model}`);
    const gatewayTools = input.gateway
      ? createAgentGatewayTools(input.gateway, { taskId: input.task.id, runId: input.task.id, workspaceRoot: agentWorkdir })
        .filter((tool) => ["github_read", "linear_read", "slack_read", "web_get"].includes(tool.name))
      : [];
    const fileTools = input.task.type === "research"
      ? createWorkspaceGuardedTools(agentWorkdir).filter((tool) => ["read", "grep", "find", "ls"].includes(tool.name))
      : [];
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
    const abort = (reason: string) => {
      if (limitError) return;
      limitError = new Error(reason);
      void session.abort().catch((err) => { limitError = new Error(`Slack agent abort failed: ${String(err)}`); });
    };
    const unsubscribe = session.subscribe((event) => {
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
      await session.prompt(`${customization.additionalSystemPrompt ?? ""}\n\n${input.prompt}`);
      if (limitError) throw limitError;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }
  } finally {
    if (netrcDir) await rm(netrcDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
