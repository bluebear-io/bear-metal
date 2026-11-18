import PQueue from "p-queue";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { ApiTaskOutcome, DbClient, TicketRun } from "../db/client.js";
import type { ApiTaskRecord, ApiTaskResult } from "../task-api/request.js";
import type { Logger } from "../shared/logger.js";
import type { WorkerGitHub } from "../worker/types.js";
import { runApiTaskAgent } from "../worker/api-task-agent.js";
import { freshTokens } from "../worker/token-budget.js";

/** Returns a delegated ticket to its human assignee. */
export interface TicketHandBack {
  handBack(ticketIssueId: string): Promise<void>;
}

/** Stops a coding task's ticket work: hands the ticket back first, so the scheduler cannot re-admit it once its slot is released. */
export async function stopTicketWork(db: DbClient, tickets: TicketHandBack, ticketIssueId: string, reason: string): Promise<void> {
  await tickets.handBack(ticketIssueId);
  await db.stopTicketWork(ticketIssueId, reason);
}

/**
 * The outcome of a coding task from its ticket's first run, or null while that run has not finished. The task
 * succeeds when the run ends ready for review with a pull request.
 */
export function ticketRunOutcome(run: TicketRun | null): ApiTaskOutcome | null {
  if (!run || run.record.resultStatus === null) return null;
  const dispatch = run.record.result;
  if (run.runStatus === "crashed" || !dispatch) {
    return { status: "failed", result: null, error: `The ticket's run ended without a result: ${run.error ?? "unknown error"}` };
  }
  const tokens = run.tokens;
  const result: ApiTaskResult = {
    message: null,
    result: null,
    pullRequests: dispatch.prs.map(({ owner, repo, number }) => ({ owner, repo, number })),
    usage: tokens ? {
      inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite,
      freshTokens: freshTokens(tokens),
    } : null,
  };
  if (run.stopReason === "token_limit") return { status: "budget", result, error: "The ticket's run reached its token budget" };
  if (run.stopReason === "time_limit") return { status: "timeout", result, error: "The ticket's run reached its time limit (the request's deadline or the customization's maxDurationMs, whichever came first)" };
  if (dispatch.status === "pending") return { status: "failed", result, error: "The ticket's run handed the ticket back to its assignee" };
  if (dispatch.prs.length === 0) return { status: "failed", result, error: "The ticket's run ended without a pull request" };
  return { status: "succeeded", result, error: null };
}

/**
 * Runs task API tasks without a ticket in slots of their own, so ticket and Slack work cannot starve them, and
 * settles coding tasks once their ticket's first run ends.
 */
export class ApiTaskWorker {
  private readonly queue: PQueue;
  private readonly startedAt = new Date().toISOString();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly input: {
    db: DbClient;
    config: BearMetalConfig;
    github: WorkerGitHub;
    /** Absent when the Linear scheduler is off; coding tasks are then refused. */
    tickets?: TicketHandBack;
    gateway?: AgentToolGatewayLike;
    logger: Logger;
    concurrency: number;
    pollIntervalMs: number;
    runAgent?: typeof runApiTaskAgent;
  }) {
    this.queue = new PQueue({ concurrency: input.concurrency });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.input.db.recoverApiTasks(this.startedAt);
    this.wake();
    this.timer = setInterval(() => this.wake(), this.input.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue.onIdle();
  }

  wake(): void {
    if (this.stopping) return;
    void this.tick().catch((err) => this.input.logger.error({ err }, "API task poll failed"));
  }

  async tick(): Promise<void> {
    if (this.input.tickets) await this.settleTicketTasks(this.input.tickets);
    while (!this.stopping && this.queue.pending + this.queue.size < this.input.concurrency) {
      const task = await this.input.db.claimApiTask();
      if (!task) return;
      void this.queue.add(() => this.run(task)).catch((err) => {
        this.input.logger.error({ err, taskId: task.id }, "cannot record API task outcome");
      });
    }
  }

  private async settleTicketTasks(tickets: TicketHandBack): Promise<void> {
    const { db, logger } = this.input;
    for (const task of await db.listRunningTicketApiTasks()) {
      try {
        const ticketIssueId = task.ticketIssueId!;
        let outcome = ticketRunOutcome(await db.getFirstTicketRun(ticketIssueId, task.startedAt!));
        if (!outcome && Date.parse(task.request.deadline) <= Date.now()) {
          await stopTicketWork(db, tickets, ticketIssueId, `Deadline ${task.request.deadline} reached`);
          outcome = { status: "timeout", result: null, error: `Deadline ${task.request.deadline} reached` };
        }
        if (!outcome) continue;
        // A first run abandoned after crashes leaves the ticket delegated, and Bear Metal would start it again.
        if (outcome.status === "failed") await stopTicketWork(db, tickets, ticketIssueId, outcome.error ?? "The ticket's first run failed");
        await db.finishApiTask(task.id, outcome);
        logger.info({ taskId: task.id, ticketIssueId, status: outcome.status, error: outcome.error }, "API coding task finished");
      } catch (err) {
        logger.error({ err, taskId: task.id }, "cannot settle API coding task");
      }
    }
  }

  private async run(task: ApiTaskRecord): Promise<void> {
    this.input.logger.info({ taskId: task.id, profile: task.request.profile.id }, "API task started");
    const outcome = await (this.input.runAgent ?? runApiTaskAgent)({
      task,
      config: this.input.config,
      db: this.input.db,
      github: this.input.github,
      gateway: this.input.gateway,
      canceled: async () => (await this.input.db.getApiTask(task.id))?.status !== "running",
    }).catch((err: unknown) => ({ status: "failed" as const, result: null, error: err instanceof Error ? err.message : String(err) }));
    const recorded = await this.input.db.finishApiTask(task.id, outcome);
    this.input.logger.info(
      { taskId: task.id, status: outcome.status, error: outcome.error, recorded },
      recorded ? "API task finished" : "API task ended after cancel",
    );
  }
}
