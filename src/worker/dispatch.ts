import { mkdir, rm } from "node:fs/promises";
import { createLogger } from "../shared/index.js";
import { runWorkspaceBuilder, workspaceForTicket } from "./clone.js";
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
  prs: PullRequestRef[];
  integrations: WorkerIntegrations;
  /** Inline bash script content for the workspace builder. Mutually exclusive with workspaceBuilderPath. */
  workspaceBuilderCommand?: string;
  /** Path to an executable workspace builder script. Mutually exclusive with workspaceBuilderCommand. */
  workspaceBuilderPath?: string;
  /** Custom system prompt content injected into the agent prompt. */
  systemPrompt?: string | null;
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
  maxWorkerTimeMs: number;
  maxWorkerTokens: number;
  llmProvider: string;
  llmApiKey: string;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { state, ticketId, integrations, prs } = input;
  validateDispatchInputs(state, ticketId, prs);

  const { github, linear, commentStore } = integrations;
  const workspaceDir = workspaceForTicket(ticketId);

  await mkdir(workspaceDir, { recursive: true });

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

  input.onWorkspaceBuilding?.();
  const cloneScript = await runWorkspaceBuilder({
    workspaceDir,
    githubToken,
    ticket: ticket.issue,
    builderCommand: input.workspaceBuilderCommand,
    builderPath: input.workspaceBuilderPath,
  }).then((r) => {
    logger.debug({ workspaceDir, agentWorkdir: r.agentWorkdir }, "workspace builder completed");
    input.onWorkspaceBuilt?.(r.agentWorkdir);
    return r;
  });

  const pullRequests = commentStore
    ? await Promise.all(
        rawPullRequests.map(async (ctx, idx) => {
          const pr = prs[idx]!;
          if (ctx.issueComments.length === 0) return ctx;
          const completedIds = await commentStore.getCompleted(pr);
          if (completedIds.size === 0) return ctx;
          return {
            ...ctx,
            issueComments: ctx.issueComments.filter((c) => !completedIds.has(c.id)),
            completedIssueComments: ctx.issueComments.filter((c) => completedIds.has(c.id)),
          };
        }),
      )
    : rawPullRequests;

  const context: WorkerInputContext = {
    state,
    ticketId,
    prs,
    ticket,
    pullRequests,
    cloneScript,
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

  logger.debug({ ticketId, workspaceDir }, "starting pi worker session");
  try {
    const result = await runPiWorker({ context, github, linear, commentStore, gitEnv, systemPrompt: input.systemPrompt, onAgentStarted: input.onAgentStarted, onToolCallProgress: input.onToolCallProgress, maxWorkerTimeMs: input.maxWorkerTimeMs, maxWorkerTokens: input.maxWorkerTokens, llmProvider: input.llmProvider, llmApiKey: input.llmApiKey, prs });
    logger.info({ ticketId, status: result.status }, "pi worker session completed");
    return result;
  } finally {
    await rm(cloneScript.netrcDir, { recursive: true, force: true });
    try {
      await rm(cloneScript.agentWorkdir, { recursive: true, force: true });
      logger.info({ ticketId, agentWorkdir: cloneScript.agentWorkdir }, "removed agent workdir");
    } catch (error) {
      logger.error({ ticketId, agentWorkdir: cloneScript.agentWorkdir, error }, "failed to remove agent workdir");
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
