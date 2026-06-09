import { createLogger, type TicketContext, type WorkerResponse } from "../shared/index.js";

// `process` (the exported function below) shadows the Node global in this module,
// so reach the environment through globalThis.
const logger = createLogger({
  level: globalThis.process.env.LOG_LEVEL ?? "info",
  name: "worker",
});

/**
 * Solver seam. Will eventually run the LLM and open the PR. The decision of
 * whether/what to solve belongs to the manager's ticket handler — this stub
 * just acknowledges the ticket.
 */
export async function process(ctx: TicketContext): Promise<WorkerResponse> {
  logger.info(
    { ticket: ctx.ticket.identifier, hasPr: ctx.pr !== null },
    "worker received ticket (stub no-op)",
  );
  return { status: "noop" };
}
