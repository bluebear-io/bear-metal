import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AuthStorage, createAgentSession, defineTool, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  push,
  createLogger,
  getCurrentBranch,
  getRemoteRef,
  type ReviewThreadComment,
} from "../shared/index.js";
import type {
  DispatchResult,
  DispatchToolCall,
  DispatchUsage,
  PullRequestRef,
  WorkerCommentStore,
  WorkerGitHub,
  WorkerInputContext,
  WorkerLinear,
  WorkerSlack,
} from "./types.js";
import { buildWorkerPrompt } from "./prompts.js";
import { assertRepoRootInWorkspace, createWorkspaceGuardedTools } from "./workspace-guard.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:pi",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

const MAX_WORKER_TIME_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_WORKER_TOKENS = 20_000_000;            // 20M tokens

// Cap on the per-tool-call result body we persist to the dashboard. Tool outputs (file reads,
// grep results) can be megabytes; the UI only needs enough to give the operator context. We
// still record the untruncated length in `outputSize` so the UI can flag truncated payloads.
const MAX_TOOL_CALL_RESULT_CHARS = 8_000;

export async function runPiWorker(input: {
  context: WorkerInputContext;
  github: WorkerGitHub;
  linear: WorkerLinear;
  slack?: WorkerSlack;
  commentStore?: WorkerCommentStore;
  gitEnv: NodeJS.ProcessEnv;
}): Promise<DispatchResult> {
  let decision: DispatchResult | undefined;
  const workspaceRoot = resolve(input.context.cloneScript.workspaceDir, "blueden");

  // PRs accumulate across multiple push_for_review calls (one per repo in this dispatch).
  // A pending decision (respond_*) carries the accumulated set so the manager keeps tracking them.
  const collectedPrs: PullRequestRef[] = [];

  // Map from GitHub node ID → comment kind, built once per dispatch from the
  // fetched PR context. Tools use this to route without inspecting ID prefixes.
  // An ID absent from this map was not shown to PI and must not be acted on.
  const commentMap = new Map<string, "thread" | "issue_comment">();
  for (const pr of input.context.pullRequests) {
    for (const thread of pr.unresolvedReviewThreads) {
      commentMap.set(thread.id, "thread");
    }
    for (const comment of pr.issueComments) {
      commentMap.set(comment.id, "issue_comment");
    }
  }

  const setDecision = (next: DispatchResult) => {
    if (next.status === "pending") {
      decision = next;
    } else {
      collectedPrs.push(...next.prs);
      // Preserve a pending decision across subsequent push_for_review calls: once a
      // respond_* tool has handed control back to a human, additional code
      // pushes must not silently flip the dispatch result to "done".
      if (decision?.status === "pending") {
        decision = { status: "pending", prs: mergePrs(decision.prs, next.prs) };
      } else {
        decision = { status: "done", prs: [...collectedPrs] };
      }
    }
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
      setDecision({ status: "pending", prs: mergePrs(input.context.prs, collectedPrs) });
      return {
        content: [{ type: "text", text: "Posted Linear comment, relinquished delegation, and marked dispatch pending." }],
        details: {},
      };
    },
  });

  const agreeWithGithubMessage = defineTool({
    name: "agree_with_github_message",
    label: "Agree with GitHub message",
    description: "Reply to a GitHub comment after fixing it, then mark it as resolved.",
    parameters: Type.Object({
      id: Type.String({ description: "The id of the open comment to act on (from openComments)." }),
    }),
    execute: async (_toolCallId, params) => {
      const kind = commentMap.get(params.id);
      if (!kind) throw new Error(`Unknown comment id: ${params.id}`);
      const pr = requireSinglePr(input.context.prs);
      if (kind === "thread") {
        logger.info({ threadId: params.id }, "pi tool: agree_with_github_message (thread)");
        await input.github.replyToReviewThread(pr, params.id, "Fixed.", unresolvedThreadsFor(input.context, pr));
        await input.github.resolveReviewThread(params.id);
        return {
          content: [{ type: "text", text: `Replied "Fixed." and resolved review thread ${params.id}.` }],
          details: {},
        };
      } else {
        logger.info({ issueCommentId: params.id }, "pi tool: agree_with_github_message (issue comment)");
        await input.commentStore?.markCompleted(pr, params.id);
        return {
          content: [{ type: "text", text: `Recorded issue comment ${params.id} as completed.` }],
          details: {},
        };
      }
    },
  });

  const disagreeWithGithubMessage = defineTool({
    name: "disagree_with_github_message",
    label: "Disagree with GitHub message",
    description: "Reply to a GitHub comment with a concrete code-backed explanation. Leaves it unresolved.",
    parameters: Type.Object({
      id: Type.String({ description: "The id of the open comment to act on (from openComments)." }),
      text: Type.String({ description: "The exact reply or response body." }),
    }),
    execute: async (_toolCallId, params) => {
      const kind = commentMap.get(params.id);
      if (!kind) throw new Error(`Unknown comment id: ${params.id}`);
      const pr = requireSinglePr(input.context.prs);
      if (kind === "thread") {
        logger.info({ threadId: params.id }, "pi tool: disagree_with_github_message (thread)");
        await input.github.replyToReviewThread(pr, params.id, params.text, unresolvedThreadsFor(input.context, pr));
        return {
          content: [{ type: "text", text: `Replied to review thread ${params.id} with disagreement.` }],
          details: {},
        };
      } else {
        logger.info({ issueCommentId: params.id }, "pi tool: disagree_with_github_message (issue comment)");
        await input.github.leaveComment(pr, params.text);
        await input.commentStore?.markCompleted(pr, params.id);
        return {
          content: [{ type: "text", text: `Posted PR comment and recorded issue comment ${params.id} as completed.` }],
          details: {},
        };
      }
    },
  });

  const markGithubMessageCompleted = defineTool({
    name: "mark_github_message_completed",
    label: "Mark GitHub message completed",
    description: "Mark a comment as completed when it needs no action (informational, FYI, already handled).",
    parameters: Type.Object({
      id: Type.String({ description: "The id of the open comment to mark completed (from openComments)." }),
    }),
    execute: async (_toolCallId, params) => {
      const kind = commentMap.get(params.id);
      if (!kind) throw new Error(`Unknown comment id: ${params.id}`);
      if (kind === "thread") {
        logger.info({ threadId: params.id }, "pi tool: mark_github_message_completed (thread)");
        await input.github.resolveReviewThread(params.id);
        return {
          content: [{ type: "text", text: `Resolved review thread ${params.id}.` }],
          details: {},
        };
      } else {
        logger.info({ issueCommentId: params.id }, "pi tool: mark_github_message_completed (issue comment)");
        await input.commentStore?.markCompleted(requireSinglePr(input.context.prs), params.id);
        return {
          content: [{ type: "text", text: `Recorded issue comment ${params.id} as completed.` }],
          details: {},
        };
      }
    },
  });

  const respondToCommentWriter = defineTool({
    name: "respond_to_comment_writer",
    label: "Respond to comment writer",
    description: "Reply to a GitHub review thread with a blocker or question, then stop for human input. Leaves the thread unresolved.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The GitHub review thread node id." }),
      text: Type.String({ description: "The exact reply body to post to the review thread." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ threadId: params.threadId }, "pi tool: respond_to_comment_writer");
      const pr = requireSinglePr(input.context.prs);
      await input.github.replyToReviewThread(
        pr,
        params.threadId,
        params.text,
        unresolvedThreadsFor(input.context, pr),
      );
      setDecision({ status: "pending", prs: mergePrs(input.context.prs, collectedPrs) });
      return {
        content: [{ type: "text", text: `Replied to review thread ${params.threadId} and set dispatch to pending.` }],
        details: {},
      };
    },
  });

  const pushForReview = defineTool({
    name: "push_for_review",
    label: "Push for review",
    description: "Push and create or update the pull request for a repository with completed code changes.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Absolute path to the git repository root containing the changes." }),
      prTitle: Type.String({ description: "Pull request title to use when creating a new PR." }),
      prBody: Type.String({ description: "Pull request body to use when creating a new PR." }),
      baseBranch: Type.Optional(Type.String({ description: "Base branch for a new PR. Defaults to repository default branch." })),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ repoRoot: params.repoRoot }, "pi tool: push_for_review");
      const repoRoot = assertRepoRootInWorkspace(workspaceRoot, params.repoRoot);
      // Refresh the .netrc token before pushing — installation tokens expire after 1 hour
      // and pi sessions can run much longer than that.
      const freshToken = await input.github.getInstallationToken();
      await writeFile(
        resolve(input.context.cloneScript.netrcDir, ".netrc"),
        `machine github.com login x-access-token password ${freshToken}\n`,
        { mode: 0o600 },
      );
      await push(repoRoot, input.gitEnv);
      const remote = await getRemoteRef(repoRoot);
      // Design constraint: at most one PR per (owner, repo) per dispatch.
      // A second push_for_review call against the same repo updates the existing PR
      // rather than creating a new branch/PR within that repo.
      // Check collectedPrs (created earlier in this dispatch) before input.context.prs (from previous dispatch).
      const existingPr =
        collectedPrs.find((p) => p.owner === remote.owner && p.repo === remote.repo) ??
        input.context.prs.find((p) => p.owner === remote.owner && p.repo === remote.repo) ??
        null;
      const isNewPr = existingPr === null;
      const pr = existingPr ?? (await createPullRequestForRepo(input.github, { ...params, repoRoot, remote }));
      setDecision({ status: "done", prs: [pr] });
      try {
        await input.linear.moveTicketToInReview(input.context.ticketId);
      } catch (err) {
        logger.warn({ err, ticketId: input.context.ticketId }, "failed to move ticket to In Review");
      }
      // DEN-2329: suppress Slack notifications for bot-only iteration churn
      // (e.g. Cursor/Baloo nits the agent auto-addresses). Always notify on
      // new tickets, and on iterations only when at least one unresolved
      // review thread's latest comment is from a human author.
      if (input.slack && shouldNotifySlackForPr(input.context, pr)) {
        // The Slack client logs and swallows its own failures so a Slack outage
        // doesn't mask a successful commit/push from the rest of the pipeline.
        await input.slack.notifyPullRequest({
          kind: isNewPr ? "opened" : "updated",
          pr,
          title: params.prTitle,
          url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          ticketId: input.context.ticketId,
          ticketUrl: input.context.ticket.issue.url,
        });
      }
      return {
        content: [{ type: "text", text: `Pushed code for PR ${pr.owner}/${pr.repo}#${pr.number}.` }],
        details: { pr },
      };
    },
  });

  const authStorage = AuthStorage.create();
  setApiKeyFromEnv(authStorage, "anthropic", "ANTHROPIC_API_KEY");
  setApiKeyFromEnv(authStorage, "openai", "OPENAI_API_KEY");
  setApiKeyFromEnv(authStorage, "google", "GOOGLE_API_KEY");

  const agentsMd = await readAgentsMd(workspaceRoot);
  const prompt = buildWorkerPrompt(input.context, { repoRoot: workspaceRoot, agentsMd });
  const workspaceDir = input.context.cloneScript.workspaceDir;
  const guardedTools = createWorkspaceGuardedTools(workspaceRoot, input.gitEnv);

  await mkdir(workspaceDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(workspaceDir, "context.json"), JSON.stringify(input.context, null, 2), "utf8"),
    writeFile(resolve(workspaceDir, "prompt.txt"), prompt, "utf8"),
  ]);
  logger.info({ workspaceDir }, "wrote context.json and prompt.txt to workspace");

  const isNew = input.context.state === "new";
  const stateTools = isNew
    ? (["respond_to_ticket_reporter", "push_for_review"] as const)
    : (["agree_with_github_message", "disagree_with_github_message", "respond_to_comment_writer", "mark_github_message_completed", "push_for_review"] as const);
  const stateCustomTools = isNew
    ? [respondToTicketReporter, pushForReview]
    : [agreeWithGithubMessage, disagreeWithGithubMessage, respondToCommentWriter, markGithubMessageCompleted, pushForReview];

  let usage: DispatchUsage | null = null;
  let toolCalls: DispatchToolCall[] = [];
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...stateTools],
    customTools: [
      ...guardedTools,
      ...stateCustomTools,
    ],
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      logger.info({ tool: event.toolName, args: event.args }, "pi tool call");
    } else if (event.type === "turn_end") {
      const msg = event.message;
      if ("role" in msg && msg.role === "assistant" && "content" in msg) {
        const text = (msg.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("");
        if (text) logger.info({ text }, "pi assistant output");
      }
    } else if (event.type === "agent_end") {
      logger.info({ messageCount: event.messages.length }, "pi agent_end");
      // DEN-2311: build the thought-process timeline from the full message history. Doing it
      // here (rather than incrementally on tool_execution_start/end) lets us pair each
      // assistant tool_use with its matching tool_result regardless of ordering quirks.
      try {
        toolCalls = extractToolCalls(event.messages as unknown as ReadonlyArray<unknown>);
      } catch (err) {
        logger.warn({ err }, "failed to extract pi tool calls from transcript");
      }
    }
  });

  logger.info({ ticketId: input.context.ticketId }, "pi session started, sending prompt");

  let limitHitReason: string | null = null;

  // Token limit: checked after every turn.
  const unsubscribeLimits = session.subscribe((event) => {
    if (event.type === "turn_end" && !limitHitReason) {
      const stats = session.getSessionStats();
      if (stats.tokens.total >= MAX_WORKER_TOKENS) {
        limitHitReason = `token limit of ${MAX_WORKER_TOKENS.toLocaleString()} reached (${stats.tokens.total.toLocaleString()} used)`;
        logger.warn({ ticketId: input.context.ticketId, tokens: stats.tokens.total }, "token limit reached; aborting session");
        session.abort().catch((err) => {
          logger.warn({ err, ticketId: input.context.ticketId }, "session.abort() rejected");
        });
      }
    }
  });

  // Time limit: fires after 2 hours regardless of turn state.
  const timeoutHandle = setTimeout(() => {
    if (!limitHitReason) {
      limitHitReason = `time limit of 2 hours reached`;
      logger.warn({ ticketId: input.context.ticketId }, "time limit reached; aborting session");
      session.abort().catch((err) => {
        logger.warn({ err, ticketId: input.context.ticketId }, "session.abort() rejected");
      });
    }
  }, MAX_WORKER_TIME_MS);

  try {
    await session.prompt(prompt);
    try {
      const stats = session.getSessionStats();
      const model = session.model;
      if (model && (stats.tokens.input > 0 || stats.tokens.output > 0)) {
        usage = {
          promptTokens: stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
          completionTokens: stats.tokens.output,
          modelName: model.name,
          provider: model.provider,
        };
        logger.info({ ticketId: input.context.ticketId, usage }, "captured pi session usage");
      }
    } catch (statsError) {
      logger.warn({ statsError }, "failed to capture pi session usage");
    }
  } catch (error) {
    if (!limitHitReason) {
      logger.error({ error, ticketId: input.context.ticketId }, "pi session threw an error");
      throw error;
    }
    logger.debug({ error, ticketId: input.context.ticketId }, "session.prompt() threw after limit abort (expected)");
  } finally {
    clearTimeout(timeoutHandle);
    unsubscribeLimits();
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

  // If a limit was hit and the worker hadn't already set a decision, hand back.
  if (limitHitReason && !decision) {
    logger.info({ ticketId: input.context.ticketId, reason: limitHitReason }, "limit hit without prior decision; handing back");
    await input.linear.commentAndHandBack(
      input.context.ticketId,
      `Stopped automatically: ${limitHitReason}. Please review progress and re-delegate to continue.`,
    );
    return { status: "pending", prs: mergePrs(input.context.prs, collectedPrs) };
  }

  if (!decision) {
    if (input.context.state === "iteration") {
      // Agent disagreed with all threads and made no code changes — replies were posted, work is done.
      decision = { status: "done", prs: mergePrs(input.context.prs, collectedPrs) };
    } else {
      throw new Error("Pi finished without calling a finish tool (push_for_review or respond_to_ticket_reporter)");
    }
  }
  // Attach LLM usage stats captured during the just-finished session (DEN-2313).
  const withUsage = usage ? { ...decision, usage } : decision;
  // Attach the tool-call timeline (DEN-2311). Empty array when no tool calls were captured.
  return toolCalls.length > 0 ? { ...withUsage, toolCalls } : withUsage;
}

// ---- Thought-process extraction (DEN-2311) ------------------------------

/**
 * Walk the pi session message history and build a flat, ordered list of tool calls. Each
 * assistant `tool_use` block becomes a step; its matching user `tool_result` block (paired by
 * id) supplies the result body and status. Assistant text emitted in the same turn as a
 * tool_use is attached as the step's `thoughtText`.
 *
 * The function is defensive about shape because the upstream message format isn't typed in
 * this file: malformed entries are skipped rather than crashing the worker.
 */
function extractToolCalls(messages: ReadonlyArray<unknown>): DispatchToolCall[] {
  // Pass 1: index tool_result blocks by their tool_use_id so we can pair them up in one go.
  const resultsById = new Map<string, { text: string; status: "ok" | "error" }>();
  for (const msg of messages) {
    if (!isMessage(msg) || msg.role !== "user") continue;
    for (const block of contentBlocks(msg)) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
      if (!id) continue;
      const text = renderResultContent(block.content);
      const status: "ok" | "error" = block.is_error === true ? "error" : "ok";
      resultsById.set(id, { text, status });
    }
  }

  // Pass 2: emit a step per assistant tool_use, in transcript order, attaching the latest
  // assistant text block in the same message as the step's thought.
  const steps: DispatchToolCall[] = [];
  let sequence = 0;
  for (const msg of messages) {
    if (!isMessage(msg) || msg.role !== "assistant") continue;
    const blocks = contentBlocks(msg);
    // Collect text blocks first so a tool_use later in the same message inherits the thought
    // even if the SDK emits text after the tool_use (defensive: tested ordering is text-first).
    const thought = blocks
      .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string" && b.text.length > 0)
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim() || null;
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const id = typeof block.id === "string" && block.id.length > 0
        ? block.id
        : `tc_${sequence}`;
      const toolName = typeof block.name === "string" ? block.name : "unknown";
      const argsJson = safeStringify(block.input);
      const result = resultsById.get(id) ?? null;
      const rawResult = result?.text ?? null;
      const outputSize = rawResult === null ? null : rawResult.length;
      const truncated = rawResult === null
        ? null
        : rawResult.length > MAX_TOOL_CALL_RESULT_CHARS
          ? `${rawResult.slice(0, MAX_TOOL_CALL_RESULT_CHARS)}… [truncated, ${rawResult.length - MAX_TOOL_CALL_RESULT_CHARS} more chars]`
          : rawResult;
      steps.push({
        id,
        sequence,
        toolName,
        argsJson,
        resultText: truncated,
        resultStatus: result === null ? "unknown" : result.status,
        outputSize,
        thoughtText: thought,
        createdAt: Date.now(),
      });
      sequence += 1;
    }
  }
  return steps;
}

/** Render a `tool_result.content` value to a flat string. Accepts either a string or an array of text blocks. */
function renderResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (isRecord(block) && typeof block.text === "string") {
        parts.push(block.text);
      } else {
        parts.push(safeStringify(block));
      }
    }
    return parts.join("\n");
  }
  return safeStringify(content);
}

function contentBlocks(msg: { content: unknown }): unknown[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

function isMessage(v: unknown): v is { role: string; content: unknown } {
  return isRecord(v) && typeof v.role === "string";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

function mergePrs(base: PullRequestRef[], collected: PullRequestRef[]): PullRequestRef[] {
  const out: PullRequestRef[] = [...base];
  for (const pr of collected) {
    const replaceIdx = out.findIndex((p) => p.owner === pr.owner && p.repo === pr.repo);
    if (replaceIdx >= 0) {
      out[replaceIdx] = pr;
    } else {
      out.push(pr);
    }
  }
  return out;
}

function shouldNotifySlackForPr(context: WorkerInputContext, pr: PullRequestRef): boolean {
  if (context.state === "new") return true;
  const threads = unresolvedThreadsFor(context, pr);
  // Iteration with no unresolved review threads ⇒ triggered by CI failure or
  // automatic re-delegation, not by a human request. Stay quiet — humans only
  // want pings for updates they explicitly asked for.
  if (threads.length === 0) return false;
  return threads.some((thread) => {
    const latest = thread.comments[thread.comments.length - 1];
    return latest ? isHumanAuthor(latest) : false;
  });
}

// Authoritative signal is the GitHub GraphQL node-ID prefix on the author:
// "U_…" = real user, "BOT_…" = GitHub App (including our own bear-metal-app,
// whose GraphQL login is the bare slug with no "[bot]" suffix). When the
// node ID is missing we fall back to the REST-style "<slug>[bot]" login
// convention used by external bots like cursor[bot] / baloo[bot].
function isHumanAuthor(comment: ReviewThreadComment): boolean {
  if (comment.authorId) return comment.authorId.startsWith("U_");
  if (!comment.author) return false;
  return !comment.author.endsWith("[bot]");
}

function unresolvedThreadsFor(context: WorkerInputContext, pr: PullRequestRef) {
  // Review-thread tools run only in single-PR iterations (enforced by requireSinglePr),
  // so we always read the threads of the sole fetched PR context.
  const idx = context.prs.findIndex(
    (p) => p.owner === pr.owner && p.repo === pr.repo && p.number === pr.number,
  );
  return context.pullRequests[idx]?.unresolvedReviewThreads ?? [];
}

async function createPullRequestForRepo(
  github: WorkerGitHub,
  params: {
    repoRoot: string;
    prTitle: string;
    prBody: string;
    baseBranch?: string;
    remote: { owner: string; repo: string };
  },
): Promise<PullRequestRef> {
  const { remote } = params;
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

function requireSinglePr(prs: PullRequestRef[]): PullRequestRef {
  if (prs.length === 0) {
    throw new Error("This tool requires an existing pull request");
  }
  if (prs.length > 1) {
    throw new Error("Review-thread tools are only supported for single-PR iterations");
  }
  return prs[0]!;
}

function setApiKeyFromEnv(authStorage: AuthStorage, provider: string, envName: string): void {
  const apiKey = process.env[envName];
  if (apiKey) {
    authStorage.setRuntimeApiKey(provider, apiKey);
  } else {
    logger.warn({ provider, envName }, "API key not set; this provider will be unavailable to the pi agent");
  }
}

async function readAgentsMd(repoRoot: string): Promise<string | undefined> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      return await readFile(join(repoRoot, name), "utf8");
    } catch {
      // try next
    }
  }
  return undefined;
}
