import { randomUUID } from "node:crypto";
import type { Logger, RunTrigger, TicketContext, WorkOutcome } from "../shared/index.js";
import type { DbClient } from "../db/client.js";

export interface ManagerTicketHandlerDeps {
  logger: Logger;
  db: DbClient;
}

export class ManagerTicketHandler {
  private readonly logger: Logger;
  private readonly db: DbClient;

  constructor(deps: ManagerTicketHandlerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
  }

  async handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome> {
    const state = ctx.prs.length === 0 ? "new" : "iteration";
    this.logger.debug(
      { ticket: ctx.ticket.identifier, state, prCount: ctx.prs.length },
      "enqueueing ticket task",
    );
    const task = await this.db.enqueue({
      state,
      ticketId: ctx.ticket.identifier,
      prs: ctx.prs.map((pr) => ({ owner: pr.owner, repo: pr.repo, number: pr.number })),
      trigger,
      ticketIssueId: ctx.ticket.id,
    });
    void this.db.recordEvent({
      id: randomUUID(),
      ticketId: ctx.ticket.id,
      runId: task.id,
      workerId: null,
      source: "manager",
      type: "dispatched",
      summary: `dispatched attempt ${task.attemptNumber}`,
      payloadJson: null,
      createdAt: new Date().toISOString(),
    });
    return { status: "pending", taskId: task.id };
  }
}
