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
  packageRoot?: string;
}

export function createWorkerProcess(deps: WorkerProcessDeps): (ctx: TicketContext) => Promise<WorkerResponse> {
  const workerLogger = deps.logger ?? logger;
  return async (ctx) => {
    const state = ctx.pr === null ? "new" : "iteration";
    const pr = ctx.pr === null ? null : { owner: ctx.pr.owner, repo: ctx.pr.repo, number: ctx.pr.number };

    workerLogger.info(
      { ticket: ctx.ticket.identifier, state, hasPr: ctx.pr !== null },
      "dispatching ticket to worker",
    );
    const result = await dispatch({
      state,
      ticketId: ctx.ticket.identifier,
      pr,
      integrations: deps,
      packageRoot: deps.packageRoot,
    });
    return { status: result.status };
  };
}
