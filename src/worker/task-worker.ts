import PQueue from "p-queue";

import type { Logger } from "../shared/index.js";
import type { TaskQueue, TaskRecord } from "../manager/tasks.js";
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
}

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
      const task = await this.tasks.acquireNext(this.workerId);
      if (!task) {
        return;
      }
      void this.queue.add(() => this.runTask(task)).catch((err) => {
        this.logger.error({ err, taskId: task.id, ticketId: task.ticketId, workerId: this.workerId }, "SQL task failed");
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
    const result = await this.runDispatch({
      ...task.input,
      integrations: this.integrations,
      packageRoot: this.packageRoot,
    });
    await this.tasks.complete(task.id, result);
    this.logger.info(
      { taskId: task.id, ticketId: task.ticketId, workerId: this.workerId, resultStatus: result.status },
      "SQL task completed",
    );
  }
}
