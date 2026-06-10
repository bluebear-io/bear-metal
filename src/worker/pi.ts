import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthStorage, createAgentSession, defineTool, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commitAndPush, createLogger, getCurrentBranch, getRemoteRef } from "../shared/index.js";
import type {
  DispatchResult,
  DispatchUsage,
  PullRequestRef,
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

export async function runPiWorker(input: {
  context: WorkerInputContext;
  github: WorkerGitHub;
  linear: WorkerLinear;
  slack?: WorkerSlack;
  gitEnv: NodeJS.ProcessEnv;
}): Promise<DispatchResult> {
  let decision: DispatchResult | undefined;
  const workspaceRoot = resolve(input.context.cloneScript.workspaceDir, "blueden");

  // PRs accumulate across multiple wrote_code calls (one per repo in this dispatch).
  // A pending decision (respond_*) carries the accumulated set so the manager keeps tracking them.
  const collectedPrs: PullRequestRef[] = [];

  const setDecision = (next: DispatchResult) => {
    if (next.status === "pending") {
      decision = next;
    } else {
      collectedPrs.push(...next.prs);
      // Preserve a pending decision across subsequent wrote_code calls: once a
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
    description: "Reply to a GitHub review thread after fixing it, then mark the thread as resolved.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The GitHub review thread node id." }),
      text: Type.String({ description: "The exact reply body to post to GitHub." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ threadId: params.threadId }, "pi tool: agree_with_github_message");
      const pr = requireSinglePr(input.context.prs);
      await input.github.replyToReviewThread(
        pr,
        params.threadId,
        params.text,
        unresolvedThreadsFor(input.context, pr),
      );
      await input.github.resolveReviewThread(params.threadId);
      return {
        content: [{ type: "text", text: `Replied to and resolved review thread ${params.threadId}.` }],
        details: {},
      };
    },
  });

  const disagreeWithGithubMessage = defineTool({
    name: "disagree_with_github_message",
    label: "Disagree with GitHub message",
    description: "Reply to a GitHub review thread with a concrete code-backed explanation. Leaves the thread unresolved.",
    parameters: Type.Object({
      threadId: Type.String({ description: "The GitHub review thread node id." }),
      text: Type.String({ description: "The exact reply body to post to GitHub." }),
    }),
    execute: async (_toolCallId, params) => {
      logger.info({ threadId: params.threadId }, "pi tool: disagree_with_github_message");
      const pr = requireSinglePr(input.context.prs);
      await input.github.replyToReviewThread(
        pr,
        params.threadId,
        params.text,
        unresolvedThreadsFor(input.context, pr),
      );
      return {
        content: [{ type: "text", text: `Replied to review thread ${params.threadId} with disagreement.` }],
        details: {},
      };
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
      // Refresh the .netrc token before pushing — installation tokens expire after 1 hour
      // and pi sessions can run much longer than that.
      const freshToken = await input.github.getInstallationToken();
      await writeFile(
        resolve(input.context.cloneScript.netrcDir, ".netrc"),
        `machine github.com login x-access-token password ${freshToken}\n`,
        { mode: 0o600 },
      );
      await commitAndPush(repoRoot, params.commitMessage, input.gitEnv);
      const remote = await getRemoteRef(repoRoot);
      // Design constraint: at most one PR per (owner, repo) per dispatch.
      // A second wrote_code call against the same repo updates the existing PR
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
  const guardedTools = createWorkspaceGuardedTools(workspaceRoot, input.gitEnv);

  await mkdir(workspaceDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(workspaceDir, "context.json"), JSON.stringify(input.context, null, 2), "utf8"),
    writeFile(resolve(workspaceDir, "prompt.txt"), prompt, "utf8"),
  ]);
  logger.info({ workspaceDir }, "wrote context.json and prompt.txt to workspace");

  const isNew = input.context.state === "new";
  const stateTools = isNew
    ? (["respond_to_ticket_reporter", "wrote_code"] as const)
    : (["agree_with_github_message", "disagree_with_github_message", "respond_to_comment_writer", "wrote_code"] as const);
  const stateCustomTools = isNew
    ? [respondToTicketReporter, wroteCode]
    : [agreeWithGithubMessage, disagreeWithGithubMessage, respondToCommentWriter, wroteCode];

  let usage: DispatchUsage | null = null;
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
      throw new Error("Pi finished without calling a finish tool (wrote_code or respond_to_ticket_reporter)");
    }
  }
  // Attach LLM usage stats captured during the just-finished session (DEN-2313).
  return usage ? { ...decision, usage } : decision;
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
  // No unresolved threads ⇒ iteration was triggered by something other than
  // bot-comment churn (e.g. CI failure, manual re-delegation). Notify so humans
  // waiting on the update aren't left in the dark.
  if (threads.length === 0) return true;
  return threads.some((thread) => {
    const latest = thread.comments[thread.comments.length - 1];
    return latest ? isHumanAuthor(latest.author) : false;
  });
}

// GitHub bot accounts have logins suffixed with "[bot]" (e.g. "cursor[bot]",
// "baloo[bot]", "bear-metal[bot]"). A missing author is treated as non-human
// since we can't attribute the comment to a person.
function isHumanAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  return !author.endsWith("[bot]");
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
