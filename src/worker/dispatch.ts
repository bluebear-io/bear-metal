import { redactSensitiveText } from "../agent-tools/transport.js";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOKENS, type BearMetalConfig } from "../customization/types.js";
import { buildTask, customizeAndResolve } from "../customization/task.js";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { createLogger } from "../shared/index.js";
import { runWorkspaceBuilder, workspaceForTicket } from "./clone.js";
import { downloadTicketAttachments } from "./attachments.js";
import { checkpointPushed, saveCheckpoint, restoreCheckpoint, type Checkpoint } from "./checkpoint.js";
import { runPiWorker } from "./pi.js";
import type {
  DispatchResult,
  DispatchState,
  DispatchToolCall,
  PullRequestRef,
  WorkerInputContext,
  WorkerIntegrations,
} from "./types.js";

export type { DispatchResult, DispatchState, PullRequestRef };

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:dispatch",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

export interface DispatchInput {
  signal?: AbortSignal;
  assertLease?: () => Promise<void>;
  checkpoint?: Checkpoint;
  state: DispatchState;
  ticketId: string;
  ticketIssueId?: string;
  hasSlackLinkedTicket?: (ticketIssueId: string) => Promise<boolean>;
  runId: string;
  prs: PullRequestRef[];
  integrations: WorkerIntegrations;
  agentToolGateway?: AgentToolGatewayLike;
  config: BearMetalConfig;
  iteration: number;
  onToolCallProgress?: (calls: DispatchToolCall[]) => void;
  onTraceEvent?: (kind: string, content: Record<string, unknown>) => void;
  onWorkspaceBuilding?: () => void;
  onWorkspaceBuilt?: (agentWorkdir: string) => void;
  onAgentStarted?: (payload: {
    state: DispatchState;
    ticket: WorkerInputContext["ticket"];
    pullRequests: WorkerInputContext["pullRequests"];
    prs: PullRequestRef[];
    prompt: string;
  }) => void;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { state, ticketId, integrations, prs } = input;
  validateDispatchInputs(state, ticketId, prs);
  input.signal?.throwIfAborted();

  const { github, linear, commentStore } = integrations;
  const workspaceDir = resolve(workspaceForTicket(ticketId), randomUUID());

  logger.debug({ ticketId, state, prCount: prs.length, workspaceDir }, "dispatch starting");

  const [githubToken, ticket, rawPullRequests, botIdentity] = await Promise.all([
    github.getInstallationToken(),
    linear.getTicketContext(ticketId).then((t) => {
      logger.debug({ ticketId }, "linear ticket fetched");
      return t;
    }),
    Promise.all(
      prs.map((pr) =>
        github.getPullRequestContext(pr).then((p) => {
          logger.debug({ owner: pr.owner, repo: pr.repo, number: pr.number }, "github PR context fetched");
          return p;
        }),
      ),
    ),
    github.getBotIdentity().then((identity) => {
      logger.debug({ login: identity.login }, "bot identity fetched");
      return identity;
    }),
  ]);

  const pullRequests = commentStore
    ? await Promise.all(rawPullRequests.map(async (ctx, idx) => {
      if (ctx.issueComments.length === 0) return ctx;
      const completedIds = await commentStore.getCompleted(prs[idx]!);
      if (completedIds.size === 0) return ctx;
      return { ...ctx, issueComments: ctx.issueComments.filter((c) => !completedIds.has(c.id)), completedIssueComments: ctx.issueComments.filter((c) => completedIds.has(c.id)) };
    }))
    : rawPullRequests;
  const ticketAttachments = ticket.attachments ?? [];
  const fromSlack = input.ticketIssueId && input.hasSlackLinkedTicket
    ? await input.hasSlackLinkedTicket(input.ticketIssueId)
    : false;
  const task = buildTask({
    state,
    iteration: input.iteration,
    ticket,
    attachments: ticketAttachments,
    prs,
    pullRequests,
    trigger: fromSlack ? "slack" : "linear",
  });
  const { customization, llm } = await customizeAndResolve(input.config, task);
  input.signal?.throwIfAborted();
  logger.info({ ticketId, provider: llm.provider, model: llm.model, modelArn: llm.modelArn }, "selected task LLM");

  await mkdir(workspaceDir, { recursive: true });
  input.onWorkspaceBuilding?.();
  const cloneScript = await runWorkspaceBuilder({
    workspaceDir,
    githubToken,
    buildWorkspace: customization.buildWorkspace,
    signal: input.signal,
  }).then((r) => {
    logger.debug({ workspaceDir, agentWorkdir: r.agentWorkdir }, "workspace builder completed");
    input.onWorkspaceBuilt?.(r.agentWorkdir);
    return r;
  });

  let retainWorkspace = false;
  try {
  input.signal?.throwIfAborted();
  const linearAccessToken = await linear.getAccessToken();
  const evidenceAttachments = await downloadTicketAttachments(
    ticketAttachments.filter((attachment) => URL.canParse(attachment.url) && new URL(attachment.url).hostname === "uploads.linear.app"),
    `${cloneScript.agentWorkdir}/.git/bear-metal-artifacts`,
    linearAccessToken,
  );

  const context: WorkerInputContext = {
    state,
    ticketId,
    prs,
    ticket,
    pullRequests,
    cloneScript,
    evidenceAttachments,
    checkpoint: input.checkpoint,
  };

  input.signal?.throwIfAborted();
  if (customization.ticketLabels?.length && linear.addLabelsByName) {
    try {
      const missing = await linear.addLabelsByName(ticket.issue.id, customization.ticketLabels);
      if (missing.length) logger.warn({ ticketId, missing }, "ticket labels not found in Linear");
    } catch (err) {
      logger.warn({ err, ticketId }, "failed to apply ticket labels");
    }
  }
  await linear.moveTicketToInProgress(ticketId);
  input.signal?.throwIfAborted();
  logger.debug({ ticketId }, "linear ticket moved to in progress");

  const botEmail = `${botIdentity.userNumericId}+${botIdentity.login}@users.noreply.github.com`;
  const gitEnv: NodeJS.ProcessEnv = {
    GIT_ASKPASS: resolve(cloneScript.netrcDir, "askpass.sh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@github.com:",
    GIT_AUTHOR_NAME: botIdentity.login,
    GIT_AUTHOR_EMAIL: botEmail,
    GIT_COMMITTER_NAME: botIdentity.login,
    GIT_COMMITTER_EMAIL: botEmail,
  };

    if (input.checkpoint) {
      try {
        await input.assertLease?.();
        if (!checkpointPushed(input.checkpoint) && (input.checkpoint.repositories.length === 0 || input.checkpoint.repositories.some((repo) => !repo.commit))) {
          const previousMessage = input.checkpoint.lastAssistantMessage;
          const resaved = await saveCheckpoint({ workspaceRoot: input.checkpoint.workspaceRoot,
            branch: ticket.issue.branchName, ticketId, gitEnv, signal: input.signal, assertLease: input.assertLease });
          input.checkpoint = { ...resaved, lastAssistantMessage: previousMessage };
          context.checkpoint = input.checkpoint;
        }
        await restoreCheckpoint(cloneScript.agentWorkdir, input.checkpoint, gitEnv, input.signal);
      } catch (error) {
        input.signal?.throwIfAborted();
        await input.assertLease?.();
        logger.error({ error: redactSensitiveText(String(error)), ticketId }, "checkpoint recovery failed; returning for operator recovery");
        return { status: "pending", prs, outcome: "interrupted", stopReason: "token_limit",
          checkpoint: { ...input.checkpoint, error: redactSensitiveText(String(error)) } };
      }
    }
    const result = await runPiWorker({
      context, github, linear, commentStore, gitEnv, agentToolGateway: input.agentToolGateway,
      signal: input.signal,
      assertLease: input.assertLease,
      onInterrupted: (reason) => { retainWorkspace ||= reason === "token_limit"; },
      runId: input.runId,
      systemPrompt: customization.additionalSystemPrompt,
      pullRequestLabels: customization.pullRequestLabels,
      allowedTools: customization.tools,
      onAgentStarted: input.onAgentStarted,
      onToolCallProgress: input.onToolCallProgress,
      onTraceEvent: input.onTraceEvent,
      maxWorkerTimeMs: customization.limits?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      maxWorkerTokens: customization.limits?.maxTokens ?? DEFAULT_MAX_TOKENS,
      llmProvider: llm.provider,
      llmApiKey: llm.apiKey,
      llmModel: llm.model,
      llmModelArn: llm.modelArn,
      prs,
    });
    retainWorkspace ||= result.outcome === "interrupted" && result.stopReason === "token_limit";
    logger.info({ ticketId, status: result.status }, "pi worker session completed");
    return result;
  } finally {
    await rm(cloneScript.netrcDir, { recursive: true, force: true });
    if (!retainWorkspace) try {
      await rm(cloneScript.workspaceDir, { recursive: true, force: true });
      logger.info({ ticketId, workspaceDir: cloneScript.workspaceDir }, "removed task workspace");
    } catch (error) {
      logger.error({ ticketId, workspaceDir: cloneScript.workspaceDir, error }, "failed to remove task workspace");
    }
  }
}

export function validateDispatchInputs(state: DispatchState, ticketId: string, prs: PullRequestRef[]): void {
  if (state !== "new" && state !== "iteration") {
    throw new Error(`Unsupported dispatch state: ${String(state)}`);
  }
  if (!ticketId.trim()) {
    throw new Error("ticketId is required");
  }
  if (state === "new" && prs.length > 0) {
    throw new Error('state "new" must not include any pull requests');
  }
  if (state === "iteration" && prs.length === 0) {
    throw new Error('state "iteration" requires at least one pull request');
  }
}
