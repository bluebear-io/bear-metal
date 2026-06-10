import { hostname } from "node:os";
import PQueue from "p-queue";

import type { Logger } from "../shared/index.js";
import type { TaskQueue, TaskRecord } from "../manager/tasks.js";
import type { DashboardReporter } from "../manager/dashboardReporter.js";
import { dispatch, type DispatchInput, type DispatchResult } from "./dispatch.js";
import type { WorkerIntegrations } from "./types.js";
import { generateWorkerName } from "./worker-name.js";

export type DispatchRunner = (input: DispatchInput) => Promise<DispatchResult>;

export interface TaskWorkerDeps {
  logger: Logger;
  tasks: TaskQueue;
  integrations: WorkerIntegrations;
  concurrency: number;
  pollIntervalMs: number;
  workerId?: string;
  packageRoot?: string;
  runDispatch?: DispatchRunner;
  reporter?: DashboardReporter;
  /** How often to refresh the heartbeat on an acquired task. Defaults to 10s. */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export class TaskWorker {
  readonly workerId: string;
  private readonly logger: Logger;
  private readonly tasks: TaskQueue;
  private readonly integrations: WorkerIntegrations;
  private readonly queue: PQueue;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly packageRoot: string | undefined;
  private readonly runDispatch: DispatchRunner;
  private readonly reporter: DashboardReporter | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly workerName: string;
  private readonly startedAtMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: TaskWorkerDeps) {
    this.workerId = deps.workerId ?? generateWorkerName();
    this.logger = deps.logger;
    this.tasks = deps.tasks;
    this.integrations = deps.integrations;
    this.concurrency = deps.concurrency;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.packageRoot = deps.packageRoot;
    this.runDispatch = deps.runDispatch ?? dispatch;
    this.reporter = deps.reporter;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.workerName = `${hostname()}/${process.pid}`;
    this.startedAtMs = Date.now();
    this.queue = new PQueue({ concurrency: deps.concurrency });
  }

  start(): void {
    void this.reporter?.workerUpsert(this.workerId, this.workerName, "idle", null, this.startedAtMs);
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
      const task = await this.tasks.acquireNext(this.workerId);
      if (!task) {
        return;
      }
      void this.queue.add(() => this.runTask(task)).catch((err) => {
        this.logger.error({ err, taskId: task.id, ticketId: task.ticketId, workerId: this.workerId }, "SQL task failed");
        void this.reporter?.runCrashedById(task.id, task.input.ticketIssueId, this.workerId, task.attemptNumber, task.input.trigger, String(err));
        void this.reporter?.workerUpsert(this.workerId, this.workerName, "idle", null, this.startedAtMs);
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
    const issueId = task.input.ticketIssueId;
    const trigger = task.input.trigger;
    void this.reporter?.runStartedById(task.id, issueId, this.workerId, task.attemptNumber, trigger);
    void this.reporter?.workerUpsert(this.workerId, this.workerName, "busy", task.id, this.startedAtMs);
    if (task.input.state === "new") {
      void this.reporter?.branchCreatedById(issueId, task.id, this.workerId, `Branch for ${task.ticketId}`);
    }
    const heartbeat = this.startHeartbeat(task.id);
    let result: DispatchResult;
    try {
      result = await this.runDispatch({
        ...task.input,
        integrations: this.integrations,
        packageRoot: this.packageRoot,
      });
    } finally {
      heartbeat.stop();
    }
    await this.tasks.complete(task.id, result);
    void this.reporter?.progressById(issueId, task.id, this.workerId, `Worker finished: ${result.status}`);
    void this.reporter?.runSucceededById(task.id, issueId, this.workerId, task.attemptNumber, trigger, result.usage ?? null);
    for (const pr of result.prs) {
      void this.reporter?.recordPrOpenedById(issueId, pr, task.id);
    }
    void this.reporter?.workerUpsert(this.workerId, this.workerName, "idle", null, this.startedAtMs);
    this.logger.info(
      { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, resultStatus: result.status },
      "SQL task completed",
    );
  }

  /**
   * Run a periodic heartbeat for `taskId` while it is in flight so the manager's stale-recovery
   * sweep can tell live workers from crashed ones. Heartbeat errors are swallowed: a transient
   * DB hiccup must not crash the worker. If the row gets recovered and re-acquired elsewhere,
   * `tasks.heartbeat` becomes a no-op for this worker (worker_id no longer matches).
   */
  private startHeartbeat(taskId: string): { stop: () => void } {
    const tick = (): void => {
      void (async () => {
        try {
          await this.tasks.heartbeat(taskId, this.workerId);
        } catch (err) {
          this.logger.warn({ err, taskId, workerId: this.workerId }, "task heartbeat failed");
        }
      })();
    };
    const timer = setInterval(tick, this.heartbeatIntervalMs);
    return {
      stop: () => clearInterval(timer),
    };
  }
}
