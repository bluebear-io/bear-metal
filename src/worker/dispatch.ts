import { mkdir, rm } from "node:fs/promises";
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOKENS, type BearMetalConfig } from "../customization/types.js";
import { buildTask, customizeAndResolve } from "../customization/task.js";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import { createLogger } from "../shared/index.js";
import { runWorkspaceBuilder, workspaceForTicket } from "./clone.js";
import { downloadTicketAttachments } from "./attachments.js";
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
  state: DispatchState;
  ticketId: string;
  runId: string;
  prs: PullRequestRef[];
  integrations: WorkerIntegrations;
  agentToolGateway?: AgentToolGatewayLike;
  config: BearMetalConfig;
  iteration: number;
  onToolCallProgress?: (calls: DispatchToolCall[]) => void;
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

  const { github, linear, commentStore } = integrations;
  const workspaceDir = workspaceForTicket(ticketId);

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
  const task = buildTask({ state, iteration: input.iteration, ticket, attachments: ticketAttachments, prs, pullRequests });
  const { customization, llm } = await customizeAndResolve(input.config, task);
  logger.info({ ticketId, provider: llm.provider, model: llm.model }, "selected task LLM");

  await mkdir(workspaceDir, { recursive: true });
  input.onWorkspaceBuilding?.();
  const cloneScript = await runWorkspaceBuilder({
    workspaceDir,
    githubToken,
    buildWorkspace: customization.buildWorkspace,
  }).then((r) => {
    logger.debug({ workspaceDir, agentWorkdir: r.agentWorkdir }, "workspace builder completed");
    input.onWorkspaceBuilt?.(r.agentWorkdir);
    return r;
  });

  try {
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
  };

  await linear.moveTicketToInProgress(ticketId);
  logger.debug({ ticketId }, "linear ticket moved to in progress");

  const botEmail = `${botIdentity.userNumericId}+${botIdentity.login}@users.noreply.github.com`;
  const gitEnv: NodeJS.ProcessEnv = {
    HOME: cloneScript.netrcDir,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@github.com:",
    GIT_AUTHOR_NAME: botIdentity.login,
    GIT_AUTHOR_EMAIL: botEmail,
    GIT_COMMITTER_NAME: botIdentity.login,
    GIT_COMMITTER_EMAIL: botEmail,
  };

    const result = await runPiWorker({
      context, github, linear, commentStore, gitEnv, agentToolGateway: input.agentToolGateway,
      runId: input.runId,
      systemPrompt: customization.additionalSystemPrompt,
      onAgentStarted: input.onAgentStarted,
      onToolCallProgress: input.onToolCallProgress,
      maxWorkerTimeMs: customization.limits?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      maxWorkerTokens: customization.limits?.maxTokens ?? DEFAULT_MAX_TOKENS,
      llmProvider: llm.provider,
      llmApiKey: llm.apiKey,
      llmModel: llm.model,
      prs,
    });
    logger.info({ ticketId, status: result.status }, "pi worker session completed");
    return result;
  } finally {
    await rm(cloneScript.netrcDir, { recursive: true, force: true });
    try {
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
