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
  packageRoot?: string;
  runDispatch?: DispatchRunner;
  /** How often to refresh the per-task heartbeat row. Falls back to a derived value if unset. */
  heartbeatIntervalMs?: number;
  /** After this many crash/stale recoveries of the same row, abandon it. */
  maxReclaims?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RECLAIMS = 3;

export class TaskWorker {
  readonly workerId: string;
  private readonly logger: Logger;
  private readonly db: DbClient;
  private readonly integrations: WorkerIntegrations;
  private readonly queue: PQueue;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly packageRoot: string | undefined;
  private readonly runDispatch: DispatchRunner;
  private readonly startedAtMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReclaims: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: TaskWorkerDeps) {
    this.workerId = deps.workerId ?? generateWorkerName();
    this.logger = deps.logger;
    this.db = deps.db;
    this.integrations = deps.integrations;
    this.concurrency = deps.concurrency;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.packageRoot = deps.packageRoot;
    this.runDispatch = deps.runDispatch ?? dispatch;
    this.startedAtMs = Date.now();
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxReclaims = deps.maxReclaims ?? DEFAULT_MAX_RECLAIMS;
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
          if (res) {
            this.logger.warn(
              { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, action: res.action, reclaimCount: res.task.reclaimCount },
              "crashed task recovered",
            );
          }
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
    const workerStartedAt = new Date().toISOString();
    void this.db.upsertRunStarted(task.id, this.workerId, workerStartedAt);
    if (task.input?.state === "new") {
      void this.db.recordEvent({
        id: randomUUID(),
        ticketId: task.ticketId,
        runId: task.id,
        workerId: this.workerId,
        source: "worker",
        type: "branch_created",
        summary: `Branch for ${task.input?.ticketId ?? task.ticketId ?? "unknown"}`,
        payloadJson: null,
        createdAt: new Date().toISOString(),
      });
    }
    // Periodic heartbeat proves liveness so the manager's stale-task recovery doesn't reclaim a row
    // owned by a still-running worker. A failed heartbeat (returns false) signals that the lease was
    // lost to a reclaim — we log loudly; runTask still continues but its complete() will fail.
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
        packageRoot: this.packageRoot,
        onToolCallProgress: (calls) => {
          void this.db.upsertToolCalls(task.id, JSON.stringify(calls));
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
    // The writes below are intentionally fire-and-forget: complete() has already released the task
    // so the scheduler can move on. A crash between here and the event/usage/toolCalls writes means
    // the dashboard misses one run's supplementary data — accepted trade-off vs. blocking the slot.
    void this.db.recordEvent({
      id: randomUUID(),
      ticketId: task.ticketId,
      runId: task.id,
      workerId: this.workerId,
      source: "worker",
      type: "progress",
      summary: `Worker finished: ${result.status}`,
      payloadJson: null,
      createdAt: new Date().toISOString(),
    });
    void this.db.upsertRunSucceeded(task.id, result.usage ?? null);
    // DEN-2311: persist the agent's thought-process timeline for the dashboard's visualizer.
    if (result.toolCalls && result.toolCalls.length > 0) {
      void this.db.upsertToolCalls(task.id, JSON.stringify(result.toolCalls));
    }
    for (const pr of result.prs) {
      void this.db.recordEvent({
        id: randomUUID(),
        ticketId: task.ticketId,
        runId: task.id,
        workerId: null,
        source: "worker",
        type: "pr_opened",
        summary: `PR #${pr.number} opened`,
        payloadJson: JSON.stringify(pr),
        createdAt: new Date().toISOString(),
      });
    }
    this.logger.info(
      { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, resultStatus: result.status },
      "SQL task completed",
    );
  }
}
