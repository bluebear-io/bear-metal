import PQueue from "p-queue";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig, Task } from "../customization/types.js";
import type { DbClient, SlackTaskRecord, SlackThreadKey } from "../db/client.js";
import type { GitHubIntegration } from "../shared/integrations/github/client.js";
import type { Logger } from "../shared/logger.js";
import { runSlackAgent } from "../worker/slack-agent.js";

export class SlackResearchWorker {
  private readonly queue = new PQueue({ concurrency: 2 });
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly input: {
    db: DbClient;
    github: GitHubIntegration;
    config: BearMetalConfig;
    gateway?: AgentToolGatewayLike;
    logger: Logger;
    pollIntervalMs: number;
    wakeThread: (key: SlackThreadKey) => Promise<void>;
    runAgent?: typeof runSlackAgent;
  }) {}

  async start(): Promise<void> {
    this.stopping = false;
    await this.input.db.recoverSlackResearchTasks();
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
    void this.tick().catch((err) => this.input.logger.error({ err }, "Slack research poll failed"));
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    while (this.queue.pending + this.queue.size < 2) {
      const task = await this.input.db.claimSlackResearchTask();
      if (!task) return;
      void this.queue.add(() => this.run(task)).catch((err) => {
        this.input.logger.error({ err, taskId: task.id }, "Slack research task failed");
        void this.input.db.getSlackTask(task.id).then((current) => {
          if (current?.state === "canceled" || current?.state === "coordinated" ||
            (current?.state === "awaiting_coordination" && current.result)) return;
          return this.input.db.failSlackTask(task.id, String(err));
        }).catch((dbErr) => {
          this.input.logger.error({ err: dbErr, taskId: task.id }, "Cannot mark Slack research task failed");
        });
      });
    }
  }

  private async run(task: SlackTaskRecord): Promise<void> {
    let answered = false;
    const answerTool = defineTool({
      name: "answer_research",
      label: "Submit research answer",
      description: "Submit the complete answer to this research task. The coordinator reviews it against the current Slack thread before posting; this tool does not post a Slack message.",
      parameters: Type.Object({ answer: Type.String({ minLength: 1, description: "The full user-facing research answer, with findings and relevant source references. Example: a summary of Claude's documented hooks and links to the official docs. Do not send only a short status or question quote." }) }),
      execute: async (_id, params) => {
        if (answered) return { content: [{ type: "text", text: "Research answer was already stored; duplicate ignored." }], details: {} };
        const latest = await this.input.db.getSlackTask(task.id);
        if (!latest) throw new Error(`Research task disappeared: ${task.id}`);
        if (latest.state === "canceled" || latest.state === "coordinated") {
          return { content: [{ type: "text", text: "Task was superseded; answer ignored." }], details: {} };
        }
        const completed = await this.input.db.completeSlackResearchTask(task.id, params.answer);
        answered = true;
        if (!completed) return { content: [{ type: "text", text: "Task was superseded; answer ignored." }], details: {} };
        await this.input.wakeThread(completed.thread);
        return { content: [{ type: "text", text: "Answer stored for thread coordination." }], details: {} };
      },
    });
    const customizationTask: Task = {
      type: "research",
      id: task.id,
      request: task.request,
      slack: { ...task.thread, sourceTs: task.sourceTs },
    };
    await (this.input.runAgent ?? runSlackAgent)({
      task: customizationTask,
      config: this.input.config,
      githubToken: await this.input.github.getInstallationToken(),
      gateway: this.input.gateway,
      tools: [answerTool],
      prompt: `Research this Slack request. Use read tools as needed. Submit exactly one answer through answer_research.\nRequest: ${JSON.stringify(task.request)}`,
    });
    if (!answered) {
      const latest = await this.input.db.getSlackTask(task.id);
      if (latest?.state === "running") throw new Error("Research agent ended without answer_research");
    }
  }
}
