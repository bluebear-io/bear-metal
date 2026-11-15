import PQueue from "p-queue";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { DbClient } from "../db/client.js";
import type { ApiTaskRecord } from "../task-api/request.js";
import type { Logger } from "../shared/logger.js";
import type { WorkerGitHub } from "../worker/types.js";
import { runApiTaskAgent } from "../worker/api-task-agent.js";

/** Runs task API tasks in slots of their own, so ticket and Slack work cannot starve them. */
export class ApiTaskWorker {
  private readonly queue: PQueue;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly input: {
    db: DbClient;
    config: BearMetalConfig;
    github: WorkerGitHub;
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
    await this.input.db.recoverApiTasks();
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
    while (!this.stopping && this.queue.pending + this.queue.size < this.input.concurrency) {
      const task = await this.input.db.claimApiTask();
      if (!task) return;
      void this.queue.add(() => this.run(task)).catch((err) => {
        this.input.logger.error({ err, taskId: task.id }, "cannot record API task outcome");
      });
    }
  }

  private async run(task: ApiTaskRecord): Promise<void> {
    this.input.logger.info({ taskId: task.id, profile: task.request.profile }, "API task started");
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
