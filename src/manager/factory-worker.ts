import PQueue from "p-queue";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { DbClient } from "../db/client.js";
import type { FactoryArtifactStore } from "../factory/artifacts.js";
import type { FactoryTaskRecord } from "../factory/task.js";
import type { Logger } from "../shared/logger.js";
import { runFactoryAgent } from "../worker/factory-agent.js";

/** Runs factory tasks in slots of their own, so ticket and Slack work cannot starve them. */
export class FactoryTaskWorker {
  private readonly queue: PQueue;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly input: {
    db: DbClient;
    config: BearMetalConfig;
    artifacts: FactoryArtifactStore;
    getGithubToken: () => Promise<string>;
    gateway?: AgentToolGatewayLike;
    logger: Logger;
    concurrency: number;
    pollIntervalMs: number;
    runAgent?: typeof runFactoryAgent;
  }) {
    this.queue = new PQueue({ concurrency: input.concurrency });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.input.db.recoverFactoryTasks();
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
    void this.tick().catch((err) => this.input.logger.error({ err }, "factory task poll failed"));
  }

  async tick(): Promise<void> {
    while (!this.stopping && this.queue.pending + this.queue.size < this.input.concurrency) {
      const task = await this.input.db.claimFactoryTask();
      if (!task) return;
      void this.queue.add(() => this.run(task)).catch((err) => {
        this.input.logger.error({ err, taskId: task.id }, "cannot record factory task outcome");
      });
    }
  }

  private async run(task: FactoryTaskRecord): Promise<void> {
    this.input.logger.info({ taskId: task.id, runId: task.request.runId, role: task.request.role }, "factory task started");
    const outcome = await (this.input.runAgent ?? runFactoryAgent)({
      task,
      config: this.input.config,
      db: this.input.db,
      artifacts: this.input.artifacts,
      getGithubToken: this.input.getGithubToken,
      gateway: this.input.gateway,
      canceled: async () => {
        const current = await this.input.db.getFactoryTask(task.id);
        return current === null || current.status === "canceled" || current.status === "superseded";
      },
    }).catch((err: unknown) => ({ status: "failed" as const, result: null, error: err instanceof Error ? err.message : String(err) }));
    const recorded = await this.input.db.finishFactoryTask(task.id, outcome);
    this.input.logger.info(
      { taskId: task.id, runId: task.request.runId, status: outcome.status, error: outcome.error, recorded },
      recorded ? "factory task finished" : "factory task ended after cancel; outcome discarded",
    );
  }
}
