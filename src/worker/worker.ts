import { createLogger, type Logger, type TicketContext, type WorkerResponse } from "../shared/index.js";
import { dispatch } from "./dispatch.js";
import type { WorkerIntegrations } from "./types.js";

// `process` (the exported function below) shadows the Node global in this module,
// so reach the environment through globalThis.
const env = globalThis.process.env;
const logger = createLogger({
  level: env.LOG_LEVEL ?? "info",
  name: "worker",
  pretty: env.LOG_PRETTY === "true" || env.LOG_PRETTY === "1",
});

export interface WorkerProcessDeps extends WorkerIntegrations {
  logger?: Logger;
  /** Inline bash script content for the workspace builder. Mutually exclusive with workspaceBuilderPath. */
  workspaceBuilderCommand?: string;
  /** Path to an executable workspace builder script. Mutually exclusive with workspaceBuilderCommand. */
  workspaceBuilderPath?: string;
  maxWorkerTimeMs: number;
  maxWorkerTokens: number;
  llmProvider: string;
  llmApiKey: string;
}

export function createWorkerProcess(deps: WorkerProcessDeps): (ctx: TicketContext) => Promise<WorkerResponse> {
  const workerLogger = deps.logger ?? logger;
  return async (ctx) => {
    const state = ctx.prs.length === 0 ? "new" : "iteration";
    const prs = ctx.prs.map((pr) => ({ owner: pr.owner, repo: pr.repo, number: pr.number }));

    workerLogger.info(
      { ticket: ctx.ticket.identifier, state, prCount: prs.length },
      "dispatching ticket to worker",
    );
    const result = await dispatch({
      state,
      ticketId: ctx.ticket.identifier,
      prs,
      integrations: deps,
      workspaceBuilderCommand: deps.workspaceBuilderCommand,
      workspaceBuilderPath: deps.workspaceBuilderPath,
      maxWorkerTimeMs: deps.maxWorkerTimeMs,
      maxWorkerTokens: deps.maxWorkerTokens,
      llmProvider: deps.llmProvider,
      llmApiKey: deps.llmApiKey,
    });
    return { status: result.status };
  };
}
