import type { Logger, RunTrigger, TicketContext, WorkOutcome } from "../shared/index.js";
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
    // Provisional trigger from PR presence; the scheduler refines this with the real reason in a later change.
    const trigger: RunTrigger = ctx.pr === null ? "new" : "delegated_back";
    this.logger.info(
      { ticket: ctx.ticket.identifier, state, hasPr: ctx.pr !== null },
      "enqueueing ticket task",
    );
    const task = await this.tasks.enqueue({
      state,
      ticketId: ctx.ticket.identifier,
      pr,
      trigger,
      ticketIssueId: ctx.ticket.id,
    });
    return { status: "pending", taskId: task.id };
  }
}
