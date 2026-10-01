import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig, Task } from "../customization/types.js";
import type { DbClient, NewSlackTask, SlackTaskRecord, SlackThreadKey } from "../db/client.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import type { Logger } from "../shared/logger.js";
import { runSlackAgent } from "../worker/slack-agent.js";
import { buildCoordinatorPayload } from "./slack-payload.js";
import type { SlackThreadApi } from "./slack-thread-api.js";

type TicketInput = Parameters<LinearIntegration["createSlackCodingTicket"]>[0];

function safeSlackLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function messagePrompt(payload: string): string {
  return `Infer the tasks requested by the new Slack messages and use the task tools to create, update, or cancel tasks. For each independent new coding request, call create_ticket. You can use list_ticket_destinations to resolve the team or an applicable project for the ticket. For each new research question, call start_research with the complete question and necessary context in request; quote is only a short label for Slack replies. Check the existing task summaries before creating a task: if a new message changes an existing task, call update_task; if it withdraws one, call cancel_task. Within the current group of new messages, follow the latest instruction before creating tasks. For example, if the group contains "Create a ticket for X" followed by "Never mind X", do not create a ticket for X; call ignore_message for the superseded request and cancel_task or ignore_message for the withdrawal, as appropriate. Make at least one decision for every message in this batch. The JSON messages array is that current group, processed together in this run. Earlier thread replies are context; tasks created from previously processed messages appear in the task summaries. Read all new messages in timestamp order before using task tools. Use get_thread_task when a task summary lacks needed detail. For truncated text or messages with files or blocks, use slack_read before deciding. Use stable 1-based requestIndex values within each source message. If a message has no request directed at Bear Metal, call ignore_message with its sourceTs and reason. Do not post to Slack.\n${payload}`;
}

function researchResultPrompt(key: SlackThreadKey, task: SlackTaskRecord): string {
  return `Review the completed research result for task ${task.id}. Call get_thread_task with this ID to read its full request and answer. Call slack_read with operation "thread_replies" and parameters ${JSON.stringify({ channel: key.channelId, ts: key.threadTs })} to inspect the current conversation. If the answer still addresses the latest request, call approve_research_result with this task ID. If the request was withdrawn or superseded, call cancel_task with this task ID. Make exactly one of those decisions. Do not post to Slack.`;
}

export class SlackCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(private readonly input: {
    db: DbClient;
    api: SlackThreadApi;
    botUserId: string;
    linear: LinearIntegration;
    config: BearMetalConfig;
    gateway?: AgentToolGatewayLike;
    logger: Logger;
    pollIntervalMs: number;
    wakeResearch: () => void;
    runAgent?: typeof runSlackAgent;
  }) {}

  start(): void {
    this.stopping = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.input.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(this.active.values());
  }

  async poll(): Promise<void> {
    if (this.stopping) return;
    try {
      const keys = await this.input.db.listSlackPendingThreads();
      for (const key of keys) void this.wake(key);
    } catch (err) {
      this.input.logger.error({ err }, "Slack coordinator poll failed");
    }
  }

  async wake(key: SlackThreadKey): Promise<void> {
    if (this.stopping) return;
    const id = `${key.workspaceId}/${key.channelId}/${key.threadTs}`;
    const current = this.active.get(id);
    if (current) return current;
    let succeeded = false;
    const run = this.runThread(key).then(() => { succeeded = true; }).catch((err) => {
      this.input.logger.error({ err, key }, "Slack thread coordination failed");
    }).finally(() => {
      this.active.delete(id);
      if (succeeded) void this.poll();
    });
    this.active.set(id, run);
    return run;
  }

  private async runThread(key: SlackThreadKey): Promise<void> {
    for (;;) {
      const pending = await this.input.db.listSlackPendingMessages(key);
      if (pending.length > 0) {
        const thread = await this.input.api.readThread(key, pending[0]!);
        if (!thread.some((message) => message.ts === pending.at(-1))) throw new Error(`Slack thread ${key.channelId}/${key.threadTs} omitted latest pending message ${pending.at(-1)}`);
        for (const message of thread) {
          if (message.user && message.user !== this.input.botUserId && !message.botId && (!message.subtype || message.subtype === "file_share")) {
            await this.input.db.recordSlackMessage(key, message.ts);
          }
        }
        const availableTs = new Set(thread.map((message) => message.ts));
        const batch = (await this.input.db.listSlackPendingMessages(key)).filter((ts) => availableTs.has(ts));
        const payload = buildCoordinatorPayload(key, batch, thread, await this.input.db.listSlackThreadTasks(key));
        const decisions = new Set<string>();
        const tools = this.createTools(key, batch, undefined, decisions);
        const task: Task = {
          type: "coordinator",
          id: randomUUID(),
          request: payload,
          slack: { ...key, sourceTs: batch.at(-1)! },
        };
        await (this.input.runAgent ?? runSlackAgent)({
          task,
          config: this.input.config,
          gateway: this.input.gateway,
          tools,
          prompt: messagePrompt(payload),
        });
        const undecided = batch.filter((ts) => !decisions.has(ts));
        if (undecided.length > 0) throw new Error(`Coordinator made no decision for Slack messages: ${undecided.join(", ")}`);
        await this.input.db.markSlackMessagesProcessed(key, batch);
      }
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      const results = (await this.input.db.listSlackThreadTasks(key)).filter((task) => task.type === "research" && task.state === "awaiting_coordination");
      for (const result of results) {
        if ((await this.input.db.listSlackPendingMessages(key)).length > 0) break;
        const current = await this.input.db.getSlackTask(result.id);
        if (!current || current.state !== "awaiting_coordination") continue;
        const request = JSON.stringify({ thread: key, resultTaskId: current.id, quote: current.quote });
        await (this.input.runAgent ?? runSlackAgent)({
          task: { type: "coordinator", id: randomUUID(), request, slack: { ...key, sourceTs: current.sourceTs } },
          config: this.input.config,
          gateway: this.input.gateway,
          tools: this.createTools(key, [], current.id),
          prompt: researchResultPrompt(key, current),
        });
        if ((await this.input.db.listSlackPendingMessages(key)).length > 0) break;
        const decided = await this.input.db.getSlackTask(current.id);
        if (decided?.state !== "approved" && decided?.state !== "canceled") throw new Error(`Coordinator made no decision for research result ${current.id}`);
      }
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      await this.postBatchReply(key);
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      await this.postResearchAnswers(key);
      const remaining = await this.input.db.listSlackPendingMessages(key);
      if (remaining.length === 0) return;
    }
  }

  private createTools(key: SlackThreadKey, pending: string[], resultTaskId?: string, decisions?: Set<string>): ToolDefinition[] {
    let resultDetailsRead = false;
    const requireSource = (sourceTs: string) => {
      if (!pending.includes(sourceTs)) throw new Error(`Message ${sourceTs} is not in this coordinator batch`);
    };
    const getTask = async (id: string) => {
      const task = await this.input.db.getSlackTask(id);
      if (!task || task.thread.workspaceId !== key.workspaceId || task.thread.channelId !== key.channelId || task.thread.threadTs !== key.threadTs) {
        throw new Error(`Task ${id} does not belong to this Slack thread`);
      }
      return task;
    };
    const createCoding = async (args: NewSlackTask & TicketInput) => {
      requireSource(args.sourceTs);
      const { task, created } = await this.input.db.createSlackTask(args);
      if (!created) {
        decisions?.add(args.sourceTs);
        return { task, created: false };
      }
      try {
        const ticket = await this.input.linear.createSlackCodingTicket(args);
        await this.input.db.attachSlackTicket(task.id, ticket.id, ticket.url);
        // Delegating before attachment lets the scheduler create a second row for this ticket.
        await this.input.linear.delegateSlackCodingTicket(ticket.id);
        const updated = await getTask(task.id);
        decisions?.add(args.sourceTs);
        return { task: updated, created: true };
      } catch (err) {
        await this.input.db.failSlackTask(task.id, String(err));
        throw err;
      }
    };
    const createResearch = async (args: NewSlackTask) => {
      requireSource(args.sourceTs);
      const result = await this.input.db.createSlackTask(args);
      if (result.created) this.input.wakeResearch();
      decisions?.add(args.sourceTs);
      return result;
    };
    const cancel = async (id: string, supersededBy?: string) => {
      const task = await getTask(id);
      if (task.state === "canceled") return task;
      await this.input.db.cancelSlackTask(id, supersededBy);
      if (task.type === "coding" && task.ticketId) {
        try {
          await this.input.linear.cancelSlackCodingTicket(task.ticketId);
        } catch (err) {
          await this.input.db.failSlackTask(id, String(err));
          throw err;
        }
      }
      return getTask(id);
    };
    const getThreadTask = defineTool({
      name: "get_thread_task",
      label: "Get thread task",
      description: "Read the complete stored request, research answer if present, state, and Linear ticket reference for one task in this thread. Use when the task summary omits details needed for a decision.",
      parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Task ID from the JSON tasks array or a task-tool result, such as the research task being reviewed; this is not a Slack timestamp or Linear issue ID." }) }),
      execute: async (_id, params) => {
        const task = await getTask(params.id);
        if (params.id === resultTaskId) resultDetailsRead = true;
        return { content: [{ type: "text", text: JSON.stringify(task) }], details: {} };
      },
    });
    const cancelTask = defineTool({
      name: "cancel_task",
      label: "Cancel thread task",
      description: "Use when a user withdraws an existing request or a completed research answer has been superseded. Cancels the task's Linear ticket when it has one; late research answers are ignored.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, description: "ID of the existing task to cancel, from the JSON tasks array, get_thread_task, or a task-tool result. Do not use a Slack timestamp or Linear issue ID." }),
        sourceTs: Type.Optional(Type.String({ minLength: 1, description: "For a new message withdrawing a task, its exact ts from the JSON messages array. Omit only during research-result review." })),
      }),
      execute: async (_id, params) => {
        if (resultTaskId && params.id !== resultTaskId) throw new Error(`Result review can only cancel task ${resultTaskId}`);
        if (resultTaskId && !resultDetailsRead) throw new Error(`Read task details before deciding on research result ${resultTaskId}`);
        if (resultTaskId && (await this.input.db.listSlackPendingMessages(key)).length > 0) throw new Error("New Slack messages arrived before research cancellation");
        if (!resultTaskId) {
          if (!params.sourceTs) throw new Error("Cancellation requires the source Slack message timestamp");
          requireSource(params.sourceTs);
        }
        const canceled = await cancel(params.id);
        if (params.sourceTs) decisions?.add(params.sourceTs);
        return { content: [{ type: "text", text: JSON.stringify(canceled) }], details: {} };
      },
    });
    if (resultTaskId) {
      return [getThreadTask, cancelTask, defineTool({
        name: "approve_research_result",
        label: "Approve research result",
        description: "After get_thread_task and a current-thread read, use this only when the stored research answer still addresses the user's latest request. Approval permits the coordinator to post the answer; this tool does not post it.",
        parameters: Type.Object({ id: Type.String({ minLength: 1, description: "ID of the completed research task named in the result-review prompt; use that task's id from get_thread_task." }) }),
        execute: async (_id, params) => {
          if (params.id !== resultTaskId) throw new Error(`Result review can only approve task ${resultTaskId}`);
          if (!resultDetailsRead) throw new Error(`Read task details before deciding on research result ${resultTaskId}`);
          await getTask(params.id);
          if ((await this.input.db.listSlackPendingMessages(key)).length > 0) throw new Error("New Slack messages arrived before research approval");
          await this.input.db.approveSlackResearchResult(params.id);
          return { content: [{ type: "text", text: "Research result approved for thread reply." }], details: {} };
        },
      })];
    }
    return [
      defineTool({
        name: "list_ticket_destinations",
        label: "List Linear destinations",
        description: "Look up Linear teams and projects when the destination for create_ticket or a coding update_task is unclear. teamId is required; projectId is optional and should be included only when a specific fitting project is known. Takes no arguments.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: JSON.stringify(await this.input.linear.listSlackTicketDestinations()) }],
          details: {},
        }),
      }),
      getThreadTask,
      defineTool({
        name: "create_ticket",
        label: "Create coding ticket",
        description: "Use once per independent new coding request. Persist its Slack source, create a Linear ticket, and delegate that ticket to Bear Metal for normal implementation. Look up destinations only when needed to resolve the team or an optional project. Returns the task and ticket link.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message containing this request, from the JSON messages array. Example: '1712345678.000100'. Do not use the thread root timestamp unless it is the source message." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index among all independent requests in sourceTs, across coding and research. For a ticket request followed by a research question in one message, use 1 and 2, not 1 twice." }),
          request: Type.String({ minLength: 1, description: "The user's complete coding request and relevant context, stored with the Slack task. The Linear worker receives description, so include the actionable requirements there too." }),
          teamId: Type.String({ minLength: 1, description: "Linear team ID for the team that should own the ticket. Use list_ticket_destinations if the team ID is unknown." }),
          projectId: Type.Optional(Type.String({ minLength: 1, description: "Optional Linear project ID. Include only when the requested work belongs to a specific project associated with teamId; otherwise omit. Use list_ticket_destinations if the project ID is unknown." })),
          title: Type.String({ minLength: 1, description: "Concise, human-readable Linear issue title describing the requested outcome." }),
          description: Type.String({ minLength: 1, description: "Complete Linear issue instructions for the coding worker, including the user's requirements and necessary context." }),
          cycleId: Type.Optional(Type.String({ minLength: 1, description: "Optional Linear cycle ID, only when an exact cycle has been resolved; omit when unknown rather than guessing." })),
        }),
        execute: async (_id, params) => {
          const result = await createCoding({ ...params, type: "coding", thread: key });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        },
      }),
      defineTool({
        name: "start_research",
        label: "Start research",
        description: "Use once per independent new research question. The research worker receives request directly; quote is only a short label used in Slack acknowledgments and final replies. Example: request asks for a summary of all hooks in Claude's official docs, while quote is 'all available hooks'.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message containing this question, from the JSON messages array. Example: '1712345678.000100'." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index among all independent requests in sourceTs, across coding and research. For a ticket request followed by this question in one message, use 2." }),
          request: Type.String({ minLength: 1, description: "Complete research instruction sent directly to the research agent. Preserve the user's full question and necessary context; do not replace it with the short quote." }),
          quote: Type.String({ minLength: 1, description: "Short phrase identifying this question in Slack replies, such as 'all available hooks'. It is not the research prompt." }),
        }),
        execute: async (_id, params) => {
          const result = await createResearch({ ...params, type: "research", thread: key });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        },
      }),
      cancelTask,
      defineTool({
        name: "ignore_message",
        label: "Ignore Slack message",
        description: "Record an explicit no-task decision for one new message, such as a greeting, a message directed elsewhere, or a request superseded later in this batch. Do not use for an actionable request that still needs a task.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new message being ignored, from the JSON messages array." }),
          reason: Type.String({ minLength: 1, description: "Brief reason no task is needed for this message, such as 'superseded by later message in this batch'." }),
        }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: `No task for ${params.sourceTs}: ${params.reason}` }], details: {} };
        },
      }),
      defineTool({
        name: "update_task",
        label: "Replace thread task",
        description: "Use when a new Slack message revises an existing task. Supersede the old task with a replacement from the new message. For coding replacements, provide teamId, title, and description, plus projectId when a specific project applies; for research replacements, provide quote. Example: 'Use TypeScript instead' replaces the earlier coding task with a revised ticket.",
        parameters: Type.Object({
          id: Type.String({ minLength: 1, description: "ID of the existing task to replace, from the JSON tasks array or get_thread_task; not a Slack timestamp or Linear issue ID." }),
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message that revises the task, from the JSON messages array." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index of this replacement among all independent requests in sourceTs, across coding and research. Never reuse another task's index from the same message." }),
          type: Type.Union([Type.Literal("coding"), Type.Literal("research")], { description: "Type of the replacement task: 'coding' creates a new delegated Linear ticket; 'research' starts a new research worker." }),
          request: Type.String({ minLength: 1, description: "Complete revised instruction after applying the user's correction and relevant prior context. For research, this is sent directly to the worker." }),
          quote: Type.Optional(Type.String({ minLength: 1, description: "Required when type='research': short identifying phrase for Slack replies, not the research instruction. Omit for coding." })),
          teamId: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': Linear team ID. Use list_ticket_destinations if unknown. Omit for research." })),
          projectId: Type.Optional(Type.String({ minLength: 1, description: "Optional when type='coding': Linear project ID whose teamIds includes teamId. Omit when no specific project applies or for research." })),
          title: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': concise title for the new Linear ticket. Omit for research." })),
          description: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': complete instructions for the new Linear ticket, including the revised requirements. Omit for research." })),
          cycleId: Type.Optional(Type.String({ minLength: 1, description: "Optional Linear cycle ID for a coding replacement, only when the exact cycle is known. Omit for research or when unknown." })),
        }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          await getTask(params.id);
          let codingInput: TicketInput | undefined;
          if (params.type === "coding") {
            if (!params.teamId || !params.title || !params.description) {
              throw new Error("Updated coding task requires Linear destination, title, and description");
            }
            codingInput = {
              teamId: params.teamId, projectId: params.projectId, title: params.title,
              description: params.description, cycleId: params.cycleId,
            };
          }
          const next = await this.input.db.createSlackTask({
            type: params.type, thread: key, sourceTs: params.sourceTs,
            requestIndex: params.requestIndex, request: params.request, quote: params.quote,
          });
          if (next.created) {
            try {
              await cancel(params.id, next.task.id);
              if (codingInput) {
                const ticket = await this.input.linear.createSlackCodingTicket(codingInput);
                await this.input.db.attachSlackTicket(next.task.id, ticket.id, ticket.url);
                await this.input.linear.delegateSlackCodingTicket(ticket.id);
              } else {
                this.input.wakeResearch();
              }
            } catch (err) {
              await this.input.db.failSlackTask(next.task.id, String(err));
              throw err;
            }
          }
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: JSON.stringify(await getTask(next.task.id)) }], details: {} };
        },
      }),
    ];
  }

  private async postBatchReply(key: SlackThreadKey): Promise<void> {
    const tasks = await this.input.db.listSlackThreadTasks(key);
    const coding = tasks.filter((task) => task.type === "coding" && task.state === "awaiting_coordination" && task.ackState === null);
    const research = tasks.filter((task) => task.type === "research" && (task.state === "queued" || task.state === "running" || task.state === "awaiting_coordination" || task.state === "approved") && task.ackState === null);
    const canceled = tasks.filter((task) => task.state === "canceled" && !task.coordinatedAt && task.ackState === null);
    if (coding.length + research.length + canceled.length === 0) return;
    const lines = [
      ...coding.map((task) => {
        if (!task.ticketUrl) throw new Error(`Coding task ${task.id} has no Linear ticket URL`);
        return `Created ticket: ${task.ticketUrl}`;
      }),
      ...canceled.map((task) => `Canceled: ${safeSlackLine(task.ticketUrl ?? task.quote ?? task.request.slice(0, 120))}`),
      ...research.map((task) => {
        if (!task.quote) throw new Error(`Research task ${task.id} has no question quote`);
        return `Looking into “${safeSlackLine(task.quote)}”.`;
      }),
    ];
    const ids = [...coding, ...research, ...canceled].map((task) => task.id);
    await this.input.db.beginSlackBatchAcknowledgment(ids);
    let replyTs: string;
    try {
      replyTs = await this.input.api.reply(key, lines.join("\n"));
    } catch (err) {
      await this.input.db.failSlackBatchAcknowledgment(ids, String(err));
      throw err;
    }
    for (const task of coding) await this.input.db.markSlackTaskCoordinated(task.id, replyTs);
    for (const task of research) await this.input.db.markSlackResearchStartedReply(task.id, replyTs);
    for (const task of canceled) await this.input.db.markSlackTaskCoordinated(task.id, replyTs);
  }

  private async postResearchAnswers(key: SlackThreadKey): Promise<void> {
    const tasks = await this.input.db.listSlackThreadTasks(key);
    for (const task of tasks) {
      if (task.type !== "research" || task.state !== "approved") continue;
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) return;
      const current = await this.input.db.getSlackTask(task.id);
      if (!current || current.state !== "approved") continue;
      if (!current.result || !current.quote) throw new Error(`Completed research task ${task.id} is missing answer or quote`);
      await this.input.db.beginSlackTaskReply(task.id);
      try {
        const replyTs = await this.input.api.reply(key, `“${safeSlackLine(current.quote)}”\n${current.result}`);
        await this.input.db.markSlackTaskCoordinated(task.id, replyTs);
      } catch (err) {
        await this.input.db.failSlackTask(task.id, String(err));
        throw err;
      }
    }
  }
}
