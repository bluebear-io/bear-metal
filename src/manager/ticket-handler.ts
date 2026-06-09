import type { Logger, RunTrigger, TicketContext, WorkOutcome } from "../shared/index.js";
import type { DashboardReporter } from "./dashboardReporter.js";
import type { TaskQueue } from "./tasks.js";

export interface ManagerTicketHandlerDeps {
  logger: Logger;
  tasks: TaskQueue;
  reporter?: DashboardReporter;
}

/**
 * Decision owner for a single ticket. Given the full merged Linear + GitHub data,
 * it decides what to do and which metadata to use, then records a SQL task for a
 * worker to acquire.
 */
export class ManagerTicketHandler {
  private readonly logger: Logger;
  private readonly tasks: TaskQueue;
  private readonly reporter?: DashboardReporter;

  constructor(deps: ManagerTicketHandlerDeps) {
    this.logger = deps.logger;
    this.tasks = deps.tasks;
    this.reporter = deps.reporter;
  }

  async handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome> {
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
      trigger,
      ticketIssueId: ctx.ticket.id,
    });
    void this.reporter?.runDispatched({ ticket: ctx.ticket, runId: task.id, workerId: null, attemptNumber: task.attemptNumber, trigger });
    return { status: "pending", taskId: task.id };
  }
}
