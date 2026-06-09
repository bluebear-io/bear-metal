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
 * worker. Today it only forwards to the no-op worker stub; the future state machine
 * grows here.
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
    // A non-noop status means the ticket is finished and its slot can be released.
    return { done: response.status !== "noop" };
  }
}
