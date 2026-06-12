import { randomUUID } from "node:crypto";
import type { Logger, RunTrigger, TicketContext, WorkOutcome } from "../shared/index.js";
import type { DbClient } from "../db/client.js";

export interface ManagerTicketHandlerDeps {
  logger: Logger;
  db: DbClient;
}

/**
 * Decision owner for a single ticket. Given the full merged Linear + GitHub data,
 * it decides what to do and which metadata to use, then records a SQL task for a
 * worker to acquire.
 */
export class ManagerTicketHandler {
  private readonly logger: Logger;
  private readonly db: DbClient;

  constructor(deps: ManagerTicketHandlerDeps) {
    this.logger = deps.logger;
    this.db = deps.db;
  }

  async handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome> {
    const state = ctx.prs.length === 0 ? "new" : "iteration";
    this.logger.info(
      { ticket: ctx.ticket.identifier, state, prCount: ctx.prs.length },
      "enqueueing ticket task",
    );
    const task = await this.db.enqueue({
      state,
      ticketId: ctx.ticket.identifier,  // keep identifier for display/JSON
      prs: ctx.prs.map((pr) => ({ owner: pr.owner, repo: pr.repo, number: pr.number })),
      trigger,
      ticketIssueId: ctx.ticket.id,  // UUID — used as DB key
    });
    void this.db.upsertTicketDispatched({
      ticket: ctx.ticket,
      runId: task.id,
      workerId: null,
      attemptNumber: task.attemptNumber,
      trigger,
    });
    void this.db.recordEvent({
      id: randomUUID(),
      ticketId: ctx.ticket.id,
      runId: task.id,
      workerId: null,
      source: "manager",
      type: "dispatched",
      summary: `Dispatched attempt ${task.attemptNumber}`,
      payloadJson: null,
      createdAt: new Date().toISOString(),
    });
    return { status: "pending", taskId: task.id };
  }
}
