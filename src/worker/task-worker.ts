import { randomUUID } from "node:crypto";
import PQueue from "p-queue";

import type { Logger } from "../shared/index.js";
import type { DbClient, TaskRecord } from "../db/client.js";
import { dispatch, type DispatchInput, type DispatchResult } from "./dispatch.js";
import type { WorkerIntegrations } from "./types.js";
import { generateWorkerName } from "./worker-name.js";

export type DispatchRunner = (input: DispatchInput) => Promise<DispatchResult>;

export interface TaskWorkerDeps {
  logger: Logger;
  db: DbClient;
  integrations: WorkerIntegrations;
  concurrency: number;
  pollIntervalMs: number;
  workerId?: string;
  /** Inline bash script content for the workspace builder. Mutually exclusive with workspaceBuilderPath. */
  workspaceBuilderCommand?: string;
  /** Path to an executable workspace builder script. Mutually exclusive with workspaceBuilderCommand. */
  workspaceBuilderPath?: string;
  /** Custom system prompt content injected into the agent prompt. */
  systemPrompt?: string | null;
  runDispatch?: DispatchRunner;
  heartbeatIntervalMs: number;
  maxReclaims: number;
  /** Linear user id the manager runs as; used to detect when a task hands the ticket back. */
  agentId: string | undefined;
  maxWorkerTimeMs: number;
  maxWorkerTokens: number;
  llmProvider: string;
  llmApiKey: string;
}

export class TaskWorker {
  readonly workerId: string;
  private readonly logger: Logger;
  private readonly db: DbClient;
  private readonly integrations: WorkerIntegrations;
  private readonly queue: PQueue;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly workspaceBuilderCommand: string | undefined;
  private readonly workspaceBuilderPath: string | undefined;
  private readonly systemPrompt: string | null | undefined;
  private readonly runDispatch: DispatchRunner;
  private readonly startedAtMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReclaims: number;
  private readonly agentId: string | undefined;
  private readonly maxWorkerTimeMs: number;
  private readonly maxWorkerTokens: number;
  private readonly llmProvider: string;
  private readonly llmApiKey: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: TaskWorkerDeps) {
    this.workerId = deps.workerId ?? generateWorkerName();
    this.logger = deps.logger;
    this.db = deps.db;
    this.integrations = deps.integrations;
    this.concurrency = deps.concurrency;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.workspaceBuilderCommand = deps.workspaceBuilderCommand;
    this.workspaceBuilderPath = deps.workspaceBuilderPath;
    this.systemPrompt = deps.systemPrompt;
    this.runDispatch = deps.runDispatch ?? dispatch;
    this.startedAtMs = Date.now();
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs;
    this.maxReclaims = deps.maxReclaims;
    this.agentId = deps.agentId;
    this.maxWorkerTimeMs = deps.maxWorkerTimeMs;
    this.maxWorkerTokens = deps.maxWorkerTokens;
    this.llmProvider = deps.llmProvider;
    this.llmApiKey = deps.llmApiKey;
    this.queue = new PQueue({ concurrency: deps.concurrency });
  }

  start(): void {
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.queue.onIdle();
  }

  async tick(): Promise<void> {
    while (this.queue.pending + this.queue.size < this.concurrency) {
      const task = await this.db.acquireNext(this.workerId);
      if (!task) {
        return;
      }
      void this.queue.add(() => this.runTask(task)).catch((err) => {
        this.logger.error({ err, taskId: task.id, ticketId: task.ticketId, workerId: this.workerId }, "SQL task failed");
        void this.db.upsertRunCrashed(task.id, String(err));
        void this.db.recordEvent({
          id: randomUUID(),
          ticketId: task.ticketId,
          runId: task.id,
          workerId: this.workerId,
          source: "worker",
          type: "worker_crashed",
          summary: String(err),
          payloadJson: null,
          createdAt: new Date().toISOString(),
        });
        // Release the row immediately so we don't have to wait for stale-heartbeat recovery on the
        // manager side. If the cap is reached the row is abandoned (terminal pending + slot released)
        // and the scheduler re-admits the ticket as a fresh start next tick.
        void this.db.markCrashed(task.id, this.workerId, this.maxReclaims).then((res) => {
          if (res) this.logger.warn(
            { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, action: res.action, reclaimCount: res.task.reclaimCount },
            "crashed task recovered",
          );
        }).catch((recoveryErr) => {
          this.logger.error({ err: recoveryErr, taskId: task.id, workerId: this.workerId }, "crashed task recovery failed");
        });
      });
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.error({ err, workerId: this.workerId }, "worker task poll failed");
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    this.logger.info(
      { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId },
      "SQL task acquired",
    );
    if (task.ticketId) {
      void this.db.setTicketStatus(task.ticketId, "in_progress");
    }
    const workerStartedAt = new Date().toISOString();
    void this.db.upsertRunStarted(task.id, this.workerId, workerStartedAt);
    void this.db.recordEvent({
      id: randomUUID(),
      ticketId: task.ticketId,
      runId: task.id,
      workerId: this.workerId,
      source: "worker",
      type: "worker_started",
      summary: `worker ${this.workerId} started on ${task.ticketId ?? "unknown"} (${task.input?.state ?? "unknown"})`,
      payloadJson: null,
      createdAt: new Date().toISOString(),
    });
    const heartbeat = setInterval(() => {
      void this.db.heartbeat(task.id, this.workerId).then((ok) => {
        if (!ok) {
          this.logger.warn(
            { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId },
            "task heartbeat lost lease; the row was reclaimed or completed elsewhere",
          );
        }
      }).catch((err) => {
        this.logger.error({ err, taskId: task.id, workerId: this.workerId }, "task heartbeat failed");
      });
    }, this.heartbeatIntervalMs);
    let result: DispatchResult;
    try {
      result = await this.runDispatch({
        ...task.input!,
        integrations: this.integrations,
        workspaceBuilderCommand: this.workspaceBuilderCommand,
        workspaceBuilderPath: this.workspaceBuilderPath,
        systemPrompt: this.systemPrompt,
        maxWorkerTimeMs: this.maxWorkerTimeMs,
        maxWorkerTokens: this.maxWorkerTokens,
        llmProvider: this.llmProvider,
        llmApiKey: this.llmApiKey,
        onToolCallProgress: (calls) => {
          void this.db.upsertToolCalls(task.id, JSON.stringify(calls));
        },
        onWorkspaceBuilding: () => {
          void this.db.recordEvent({
            id: randomUUID(),
            ticketId: task.ticketId,
            runId: task.id,
            workerId: this.workerId,
            source: "worker",
            type: "workspace_building",
            summary: "workspace builder started",
            payloadJson: null,
            createdAt: new Date().toISOString(),
          });
        },
        onWorkspaceBuilt: (agentWorkdir) => {
          void this.db.recordEvent({
            id: randomUUID(),
            ticketId: task.ticketId,
            runId: task.id,
            workerId: this.workerId,
            source: "worker",
            type: "workspace_built",
            summary: `workspace ready at ${agentWorkdir}`,
            payloadJson: null,
            createdAt: new Date().toISOString(),
          });
        },
        onAgentStarted: (payload) => {
          const { issue } = payload.ticket;
          const prCount = payload.prs.length;
          void this.db.recordEvent({
            id: randomUUID(),
            ticketId: task.ticketId,
            runId: task.id,
            workerId: this.workerId,
            source: "worker",
            type: "agent_started",
            summary: `coding agent started — ${issue.identifier}: ${issue.title}${prCount > 0 ? ` (${prCount} PR${prCount > 1 ? "s" : ""})` : ""}`,
            payloadJson: JSON.stringify(payload),
            createdAt: new Date().toISOString(),
          });
        },
      });
    } catch (err) {
      void this.db.upsertRunCrashed(task.id, String(err));
      void this.db.recordEvent({
        id: randomUUID(),
        ticketId: task.ticketId,
        runId: task.id,
        workerId: this.workerId,
        source: "worker",
        type: "worker_crashed",
        summary: String(err),
        payloadJson: null,
        createdAt: new Date().toISOString(),
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
    }
    await this.db.complete(task.id, result);

    if (task.ticketId) {
      if (result.status === "pending") {
        if (this.agentId) {
          try {
            const freshCtx = await this.integrations.linear.getTicketContext(task.ticketId);
            if (freshCtx.issue.delegate?.id !== this.agentId) {
              void this.db.setTicketStatus(task.ticketId, "waiting_for_human");
            }
          } catch (err) {
            this.logger.warn({ err, ticketId: task.ticketId }, "failed to check delegation for status update");
          }
        }
      } else if (result.status === "done" && result.prs.length > 0) {
        this.logger.debug(
          { ticketId: task.ticketId, taskId: task.id, notifyOnComplete: result.notifyOnComplete ?? false },
          "setting ticket status to validating",
        );
        void this.db.setTicketStatus(task.ticketId, "validating", result.notifyOnComplete ?? false);
      }
    }

    // Fire-and-forget: complete() already released the slot; crashes here only lose dashboard supplementary data.
    void this.db.upsertRunSucceeded(task.id, result.usage ?? null);
    if (result.toolCalls && result.toolCalls.length > 0) {
      void this.db.upsertToolCalls(task.id, JSON.stringify(result.toolCalls));
    }
    const existingPrKeys = new Set((task.input?.prs ?? []).map((p) => `${p.owner}/${p.repo}/${p.number}`));
    for (const pr of result.prs) {
      if (existingPrKeys.has(`${pr.owner}/${pr.repo}/${pr.number}`)) continue;
      void this.db.recordEvent({
        id: randomUUID(),
        ticketId: task.ticketId,
        runId: task.id,
        workerId: null,
        source: "worker",
        type: "pr_opened",
        summary: `pull request #${pr.number} opened`,
        payloadJson: JSON.stringify(pr),
        createdAt: new Date().toISOString(),
      });
    }
    void this.db.recordEvent({
      id: randomUUID(),
      ticketId: task.ticketId,
      runId: task.id,
      workerId: this.workerId,
      source: "worker",
      type: "progress",
      summary: `worker finished: ${result.status}`,
      payloadJson: null,
      createdAt: new Date().toISOString(),
    });
    this.logger.info(
      { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, resultStatus: result.status },
      "SQL task completed",
    );
  }
}
