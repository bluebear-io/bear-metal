import { mkdir } from "node:fs/promises";
import { getPackageRoot, runCloneScript, workspaceForTicket } from "./clone.js";
import { readWorkerConfig } from "./env.js";
import { GitHubClient } from "./github.js";
import { LinearClient } from "./linear.js";
import { runPiWorker } from "./pi.js";
import type { DispatchResult, DispatchState, PullRequestRef, WorkerInputContext } from "./types.js";

export type { DispatchResult, DispatchState, PullRequestRef };

export async function dispatch(
  state: DispatchState,
  ticketId: string,
  pr: PullRequestRef | null = null,
): Promise<DispatchResult> {
  validateDispatchInputs(state, ticketId, pr);

  const config = readWorkerConfig();
  const github = new GitHubClient(config.githubToken);
  const linear = new LinearClient(config.linearApiKey);
  const packageRoot = getPackageRoot(import.meta.url);
  const workspaceDir = workspaceForTicket(packageRoot, ticketId);

  await mkdir(workspaceDir, { recursive: true });

  const [ticket, pullRequest, cloneScript] = await Promise.all([
    linear.getTicketContext(ticketId),
    pr ? github.getPullRequestContext(pr) : Promise.resolve(null),
    runCloneScript({ packageRoot, workspaceDir }),
  ]);

  const context: WorkerInputContext = {
    state,
    ticketId,
    pr,
    ticket,
    pullRequest,
    cloneScript,
  };

  return runPiWorker({ context, config, github, linear });
}

export function validateDispatchInputs(state: DispatchState, ticketId: string, pr: PullRequestRef | null): void {
  if (state !== "new" && state !== "iteration") {
    throw new Error(`Unsupported dispatch state: ${String(state)}`);
  }
  if (!ticketId.trim()) {
    throw new Error("ticketId is required");
  }
  if (state === "new" && pr !== null) {
    throw new Error('state "new" must not include a pull request');
  }
  if (state === "iteration" && pr === null) {
    throw new Error('state "iteration" requires a pull request');
  }
}
