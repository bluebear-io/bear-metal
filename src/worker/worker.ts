import { createLogger, type TicketContext, type WorkerResponse } from "../shared/index.js";
import { dispatch } from "./dispatch.js";
import { readWorkerConfig } from "./env.js";

// `process` (the exported function below) shadows the Node global in this module,
// so reach the environment through globalThis.
const logger = createLogger({
  level: globalThis.process.env.LOG_LEVEL ?? "info",
  name: "worker",
});

export async function process(ctx: TicketContext): Promise<WorkerResponse> {
  const config = readWorkerConfig();
  const state = ctx.pr === null ? "new" : "iteration";
  const pr =
    ctx.pr === null
      ? null
      : {
          org: config.githubOwner,
          repo: config.githubRepo,
          number: String(ctx.pr.number),
        };

  logger.info(
    { ticket: ctx.ticket.identifier, state, hasPr: ctx.pr !== null },
    "dispatching ticket to worker",
  );
  const result = await dispatch(state, ctx.ticket.identifier, pr);
  return { status: result.status };
}
