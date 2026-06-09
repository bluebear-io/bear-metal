import { mkdir } from "node:fs/promises";
import { getPackageRoot, runCloneScript, workspaceForTicket } from "./clone.js";
import { runPiWorker } from "./pi.js";
import type { DispatchResult, DispatchState, PullRequestRef, WorkerInputContext, WorkerIntegrations } from "./types.js";

export type { DispatchResult, DispatchState, PullRequestRef };

export interface DispatchInput {
  state: DispatchState;
  ticketId: string;
  pr?: PullRequestRef | null;
  integrations: WorkerIntegrations;
  packageRoot?: string;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { state, ticketId, integrations } = input;
  const pr = input.pr ?? null;
  validateDispatchInputs(state, ticketId, pr);

  const { github, linear } = integrations;
  const packageRoot = input.packageRoot ?? getPackageRoot(import.meta.url);
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

  return runPiWorker({ context, github, linear });
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
