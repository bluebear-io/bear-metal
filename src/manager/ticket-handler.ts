import type { Logger, TicketContext, WorkOutcome } from "../shared/index.js";
import type { TaskQueue } from "./tasks.js";

export interface ManagerTicketHandlerDeps {
  logger: Logger;
  tasks: TaskQueue;
}

/**
 * Decision owner for a single ticket. Given the full merged Linear + GitHub data,
 * it decides what to do and which metadata to use, then records a SQL task for a
 * worker to acquire.
 */
export class ManagerTicketHandler {
  private readonly logger: Logger;
  private readonly tasks: TaskQueue;

  constructor(deps: ManagerTicketHandlerDeps) {
    this.logger = deps.logger;
    this.tasks = deps.tasks;
  }

  async handle(ctx: TicketContext): Promise<WorkOutcome> {
    const state = ctx.pr === null ? "new" : "iteration";
    const pr = ctx.pr === null ? null : { owner: ctx.pr.owner, repo: ctx.pr.repo, number: ctx.pr.number };
    this.logger.info(
      { ticket: ctx.ticket.identifier, state, hasPr: ctx.pr !== null },
      "enqueueing ticket task",
    );
    const task = await this.tasks.enqueue({
      state,
      ticketId: ctx.ticket.identifier,
      pr,
    });
    return { status: "pending", taskId: task.id };
  }
}
