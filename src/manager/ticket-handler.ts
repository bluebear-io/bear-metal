import type { Logger, TicketContext, WorkOutcome, WorkerResponse } from "../shared/index.js";

/** The worker entry point the handler delegates to. */
export type WorkerProcess = (ctx: TicketContext) => Promise<WorkerResponse>;

export interface ManagerTicketHandlerDeps {
  logger: Logger;
  worker: WorkerProcess;
}

/**
 * Decision owner for a single ticket. Given the full merged Linear + GitHub data,
 * it decides what to do and which metadata to use, then delegates solving to the
 * worker and reports the worker's dispatch status back to the scheduler.
 */
export class ManagerTicketHandler {
  private readonly logger: Logger;
  private readonly worker: WorkerProcess;

  constructor(deps: ManagerTicketHandlerDeps) {
    this.logger = deps.logger;
    this.worker = deps.worker;
  }

  async handle(ctx: TicketContext): Promise<WorkOutcome> {
    this.logger.info(
      { ticket: ctx.ticket.identifier, hasPr: ctx.pr !== null },
      "handling ticket",
    );
    const response = await this.worker(ctx);
    return { status: response.status };
  }
}
