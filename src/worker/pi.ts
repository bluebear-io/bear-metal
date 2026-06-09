import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthStorage, createAgentSession, defineTool, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { commitAndPush, createLogger, getCurrentBranch, getRemoteRef } from "../shared/index.js";
import type { DispatchResult, PullRequestRef, WorkerGitHub, WorkerInputContext, WorkerLinear } from "./types.js";
import { buildWorkerPrompt } from "./prompts.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:pi",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

export async function runPiWorker(input: {
  context: WorkerInputContext;
  github: WorkerGitHub;
  linear: WorkerLinear;
}): Promise<DispatchResult> {
  let decision: DispatchResult | undefined;

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
      await input.linear.commentAndAssignToCreator(input.context.ticketId, params.text);
      setDecision({ status: "pending", pr: input.context.pr });
      return {
        content: [{ type: "text", text: "Posted Linear comment, reassigned to creator, and marked dispatch pending." }],
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
      await commitAndPush(params.repoRoot, params.commitMessage);
      const pr = input.context.pr ?? (await createPullRequestForRepo(input.github, params));
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

  await mkdir(workspaceDir, { recursive: true });
  await Promise.all([
    writeFile(resolve(workspaceDir, "context.json"), JSON.stringify(input.context, null, 2), "utf8"),
    writeFile(resolve(workspaceDir, "prompt.txt"), prompt, "utf8"),
  ]);
  logger.info({ workspaceDir }, "wrote context.json and prompt.txt to workspace");

  const { session } = await createAgentSession({
    cwd: workspaceDir,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    customTools: [respondToTicketReporter, agreeWithGithubMessage, disagreeWithGithubMessage, wroteCode],
  });

  logger.info({ ticketId: input.context.ticketId }, "pi session started, sending prompt");

  try {
    await session.prompt(prompt);
  } catch (error) {
    logger.error({ error, ticketId: input.context.ticketId }, "pi session threw an error");
    throw error;
  } finally {
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

function setApiKeyFromEnv(authStorage: AuthStorage, provider: string, envName: string): void {
  const apiKey = process.env[envName];
  if (apiKey) {
    authStorage.setRuntimeApiKey(provider, apiKey);
  } else {
    logger.warn({ provider, envName }, "API key not set; this provider will be unavailable to the pi agent");
  }
}
