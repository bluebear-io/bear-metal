import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AuthStorage, createAgentSession, defineTool, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commitAndPush, createLogger, getCurrentBranch, getRemoteRef } from "../shared/index.js";
import type { RunToolCallPayload } from "../shared/index.js";
import type { DispatchResult, PullRequestRef, RunToolCallRecorder, WorkerGitHub, WorkerInputContext, WorkerLinear } from "./types.js";
import { buildWorkerPrompt } from "./prompts.js";
import { assertRepoRootInWorkspace, createWorkspaceGuardedTools } from "./workspace-guard.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:pi",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

export async function runPiWorker(input: {
  context: WorkerInputContext;
  github: WorkerGitHub;
  linear: WorkerLinear;
  runId?: string;
  recordToolCall?: RunToolCallRecorder;
}): Promise<DispatchResult> {
  let decision: DispatchResult | undefined;
  const workspaceRoot = resolve(input.context.cloneScript.workspaceDir, "blueden");

  const setDecision = (next: DispatchResult) => {
    if (decision) {
      throw new Error(`Pi attempted to finish twice: ${decision.status} then ${next.status}`);
    }
    decision = next;
  };

  const respondToTicketReporter = defineTool({
    name: "respond_to_ticket_reporter",
    label: "Respond to ticket reporter",
    description: "Write a Linear comment explaining the blocker or question, then stop for human input.",
    parameters: Type.Object({
      text: Type.String({ description: "The exact comment body to post to Linear." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ ticketId: input.context.ticketId, textLength: params.text.length }, "pi tool: respond_to_ticket_reporter");
      await input.linear.commentAndHandBack(input.context.ticketId, params.text);
      setDecision({ status: "pending", pr: input.context.pr });
      return {
        content: [{ type: "text", text: "Posted Linear comment, relinquished delegation, and marked dispatch pending." }],
        details: {},
      };
    },
  });

  const agreeWithGithubMessage = defineTool({
    name: "agree_with_github_message",
    label: "Agree with GitHub message",
    description: "Mark a GitHub review thread as accepted/addressed after fixing it.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The GitHub review thread node id." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ threadId: params.threadId }, "pi tool: agree_with_github_message");
      requirePullRequest(input.context.pr);
      await input.github.resolveReviewThread(params.threadId);
      return {
        content: [{ type: "text", text: `Resolved review thread ${params.threadId}.` }],
        details: {},
      };
    },
  });

  const disagreeWithGithubMessage = defineTool({
    name: "disagree_with_github_message",
    label: "Disagree with GitHub message",
    description: "Reply to a GitHub review thread with a concrete code-backed explanation.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The GitHub review thread node id." }),
      text: Type.String({ description: "The exact reply body to post to GitHub." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ threadId: params.threadId }, "pi tool: disagree_with_github_message");
      const pr = requirePullRequest(input.context.pr);
      await input.github.replyToReviewThread(
        pr,
        params.threadId,
        params.text,
        input.context.pullRequest?.unresolvedReviewThreads ?? [],
      );
      return {
        content: [{ type: "text", text: `Replied to review thread ${params.threadId}.` }],
        details: {},
      };
    },
  });

  const wroteCode = defineTool({
    name: "wrote_code",
    label: "Wrote code",
    description: "Commit, push, and create or update the pull request for a repository with completed code changes.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Absolute path to the git repository root containing the changes." }),
      commitMessage: Type.String({ description: "Commit message to use." }),
      prTitle: Type.String({ description: "Pull request title to use when creating a new PR." }),
      prBody: Type.String({ description: "Pull request body to use when creating a new PR." }),
      baseBranch: Type.Optional(Type.String({ description: "Base branch for a new PR. Defaults to repository default branch." })),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ repoRoot: params.repoRoot, commitMessage: params.commitMessage }, "pi tool: wrote_code");
      const repoRoot = assertRepoRootInWorkspace(workspaceRoot, params.repoRoot);
      await commitAndPush(repoRoot, params.commitMessage);
      const pr = input.context.pr ?? (await createPullRequestForRepo(input.github, { ...params, repoRoot }));
      setDecision({ status: "done", pr });
      return {
        content: [{ type: "text", text: `Committed and pushed code for PR ${pr.owner}/${pr.repo}#${pr.number}.` }],
        details: { pr },
      };
    },
  });

  const authStorage = AuthStorage.create();
  setApiKeyFromEnv(authStorage, "anthropic", "ANTHROPIC_API_KEY");
  setApiKeyFromEnv(authStorage, "openai", "OPENAI_API_KEY");
  setApiKeyFromEnv(authStorage, "google", "GOOGLE_API_KEY");

  const prompt = buildWorkerPrompt(input.context);
  const workspaceDir = input.context.cloneScript.workspaceDir;
  const guardedTools = createWorkspaceGuardedTools(workspaceRoot);

  await mkdir(workspaceDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(workspaceDir, "context.json"), JSON.stringify(input.context, null, 2), "utf8"),
    writeFile(resolve(workspaceDir, "prompt.txt"), prompt, "utf8"),
  ]);
  logger.info({ workspaceDir }, "wrote context.json and prompt.txt to workspace");

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "respond_to_ticket_reporter", "agree_with_github_message", "disagree_with_github_message", "wrote_code"],
    customTools: [
      ...guardedTools,
      respondToTicketReporter,
      agreeWithGithubMessage,
      disagreeWithGithubMessage,
      wroteCode,
    ],
  });

  const thoughtTreeRecorder = createThoughtTreeRecorder({
    runId: input.runId,
    recordToolCall: input.recordToolCall,
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      logger.info({ tool: event.toolName, args: event.args }, "pi tool call");
      thoughtTreeRecorder.onToolStart(event as unknown as Record<string, unknown>);
    } else if (event.type === "tool_execution_end") {
      thoughtTreeRecorder.onToolEnd(event as unknown as Record<string, unknown>);
    } else if (event.type === "turn_end") {
      const msg = event.message;
      if ("role" in msg && msg.role === "assistant" && "content" in msg) {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("");
        if (text) {
          logger.info({ text }, "pi assistant output");
          thoughtTreeRecorder.onThought(text);
        }
      }
    } else if (event.type === "agent_end") {
      logger.info({ messageCount: event.messages.length }, "pi agent_end");
    }
  });

  logger.info({ ticketId: input.context.ticketId }, "pi session started, sending prompt");

  try {
    await session.prompt(prompt);
  } catch (error) {
    logger.error({ error, ticketId: input.context.ticketId }, "pi session threw an error");
    throw error;
  } finally {
    const transcriptPath = resolve(workspaceDir, "session.jsonl");
    try {
      session.exportToJsonl(transcriptPath);
      logger.info({ transcriptPath }, "pi session transcript saved");
    } catch (exportError) {
      logger.warn({ exportError }, "failed to export session transcript");
    }
    unsubscribe();
    session.dispose();
    logger.info({ ticketId: input.context.ticketId, hasDecision: !!decision }, "pi session disposed");
  }

  if (!decision) {
    throw new Error("Pi finished without calling respond_to_ticket_reporter or wrote_code");
  }
  return decision;
}

async function createPullRequestForRepo(
  github: WorkerGitHub,
  params: { repoRoot: string; prTitle: string; prBody: string; baseBranch?: string },
): Promise<PullRequestRef> {
  const remote = await getRemoteRef(params.repoRoot);
  const branch = await getCurrentBranch(params.repoRoot);
  const base = params.baseBranch ?? (await github.getDefaultBranch(remote.owner, remote.repo));
  return github.createPullRequest({
    owner: remote.owner,
    repo: remote.repo,
    title: params.prTitle,
    head: branch,
    base,
    body: params.prBody,
  });
}

function requirePullRequest(pr: PullRequestRef | null): PullRequestRef {
  if (!pr) {
    throw new Error("This tool requires an existing pull request");
  }
  return pr;
}

interface ThoughtTreeRecorderDeps {
  runId?: string;
  recordToolCall?: RunToolCallRecorder;
}

/**
 * Emits run_tool_calls rows for the dashboard as the pi session runs. The dashboard is a
 * best-effort read model (see DEN-2288), so we never let a recorder failure bubble into the
 * agent loop. We key tool_call rows by the pi-supplied toolCallId so end events upsert the
 * same row that start events created.
 */
function createThoughtTreeRecorder(deps: ThoughtTreeRecorderDeps) {
  let sequence = 0;
  const MAX_RESULT_TEXT = 10_000;

  const enabled = deps.runId !== undefined && deps.recordToolCall !== undefined;

  const emit = (payload: RunToolCallPayload): void => {
    if (!enabled) return;
    try {
      deps.recordToolCall!(payload);
    } catch (err) {
      logger.warn({ err }, "thought-tree recorder threw (ignored)");
    }
  };

  const stringify = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  return {
    onToolStart(event: Record<string, unknown>): void {
      if (!enabled) return;
      const now = Date.now();
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
      const toolName = typeof event.toolName === "string" ? event.toolName : null;
      const paramsJson = stringify(event.args);
      emit({
        id: toolCallId, runId: deps.runId!, sequence: sequence++,
        kind: "tool_call", toolName, paramsJson,
        status: "running", resultText: null, resultSize: null,
        thoughtText: null, startedAt: now, endedAt: null,
      });
    },
    onToolEnd(event: Record<string, unknown>): void {
      if (!enabled) return;
      const now = Date.now();
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
      const toolName = typeof event.toolName === "string" ? event.toolName : null;
      const fullResult = stringify(event.result) ?? stringify(event.output) ?? stringify(event.content);
      const isError = event.isError === true || event.status === "error";
      const resultText = fullResult === null ? null : fullResult.slice(0, MAX_RESULT_TEXT);
      const resultSize = fullResult === null ? null : fullResult.length;
      emit({
        id: toolCallId, runId: deps.runId!, sequence: sequence++,
        kind: "tool_call", toolName, paramsJson: stringify(event.args),
        status: isError ? "error" : "success",
        resultText, resultSize, thoughtText: null,
        startedAt: now, endedAt: now,
      });
    },
    onThought(text: string): void {
      if (!enabled) return;
      const now = Date.now();
      emit({
        id: randomUUID(), runId: deps.runId!, sequence: sequence++,
        kind: "thought", toolName: null, paramsJson: null,
        status: null, resultText: null, resultSize: null,
        thoughtText: text, startedAt: now, endedAt: now,
      });
    },
  };
}

function setApiKeyFromEnv(authStorage: AuthStorage, provider: string, envName: string): void {
  const apiKey = process.env[envName];
  if (apiKey) {
    authStorage.setRuntimeApiKey(provider, apiKey);
  } else {
    logger.warn({ provider, envName }, "API key not set; this provider will be unavailable to the pi agent");
  }
}
