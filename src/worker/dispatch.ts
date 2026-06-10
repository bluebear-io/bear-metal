import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../shared/index.js";
import { getPackageRoot, runCloneScript, workspaceForTicket } from "./clone.js";
import { runPiWorker } from "./pi.js";
import type {
  DispatchResult,
  DispatchState,
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
  prs?: PullRequestRef[];
  integrations: WorkerIntegrations;
  packageRoot?: string;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { state, ticketId, integrations } = input;
  const prs = input.prs ?? [];
  validateDispatchInputs(state, ticketId, prs);

  const { github, linear, slack } = integrations;
  const packageRoot = input.packageRoot ?? getPackageRoot(import.meta.url);
  const workspaceDir = workspaceForTicket(packageRoot, ticketId);

  await mkdir(workspaceDir, { recursive: true });

  logger.info({ ticketId, state, prCount: prs.length, workspaceDir }, "dispatch starting");

  const githubToken = await github.getInstallationToken();

  const [ticket, pullRequests, cloneScript] = await Promise.all([
    linear.getTicketContext(ticketId).then((t) => {
      logger.info({ ticketId }, "linear ticket fetched");
      return t;
    }),
    Promise.all(
      prs.map((pr) =>
        github.getPullRequestContext(pr).then((p) => {
          logger.info({ owner: pr.owner, repo: pr.repo, number: pr.number }, "github PR context fetched");
          return p;
        }),
      ),
    ),
    runCloneScript({ packageRoot, workspaceDir, githubToken }).then((r) => {
      logger.info({ workspaceDir, scriptPath: r.scriptPath }, "clone script completed");
      return r;
    }),
  ]);

  const context: WorkerInputContext = {
    state,
    ticketId,
    prs,
    ticket,
    pullRequests,
    cloneScript,
  };

  await linear.moveTicketToInProgress(ticketId);
  logger.info({ ticketId }, "linear ticket moved to in progress");

  const gitEnv: NodeJS.ProcessEnv = {
    HOME: cloneScript.netrcDir,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@github.com:",
  };

  logger.info({ ticketId, workspaceDir }, "starting pi worker session");
  try {
    const result = await runPiWorker({ context, github, linear, slack, gitEnv });
    logger.info({ ticketId, status: result.status }, "pi worker session completed");
    return result;
  } finally {
    await rm(cloneScript.netrcDir, { recursive: true, force: true });
    // Housekeeping: drop the checked-out blueden tree (and its nested sub-repos)
    // so disk usage doesn't grow with every ticket. The next dispatch will re-clone.
    const checkoutDir = resolve(workspaceDir, "blueden");
    try {
      await rm(checkoutDir, { recursive: true, force: true });
      logger.info({ ticketId, checkoutDir }, "removed checked-out workspace folder");
    } catch (error) {
      logger.error({ ticketId, checkoutDir, error }, "failed to remove checked-out workspace folder");
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
