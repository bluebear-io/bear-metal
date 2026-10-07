import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentToolGatewayLike } from "../agent-tools/types.js";
import type { BearMetalConfig, Task } from "../customization/types.js";
import type { DbClient, NewSlackTask, SlackCoordinationReply, SlackTaskRecord, SlackThreadKey } from "../db/client.js";
import { slackReplyKey } from "../db/client.js";
import { SlackThreadReplyRejectedError } from "../shared/integrations/slack/client.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import type { GitHubIntegration } from "../shared/integrations/github/client.js";
import type { Logger } from "../shared/logger.js";
import { runSlackAgent } from "../worker/slack-agent.js";
import { buildCoordinatorPayload } from "./slack-payload.js";
import type { SlackThreadApi } from "./slack-thread-api.js";

type TicketInput = Parameters<LinearIntegration["createSlackCodingTicket"]>[0];
type CoordinationReply = SlackCoordinationReply;

function safeSlackLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function applyResearchCorrection(request: string, correction: string): string {
  return `${request}\n\nCorrection: ${correction}\nLater corrections override earlier conflicting details; retain the original scope, sources, and other unchanged requirements.`;
}

function messagePrompt(key: SlackThreadKey, payload: string, canIgnore: boolean): string {
  return `Infer the requests directed at Bear Metal in the new Slack messages and use the task tools to create, update, cancel, or clarify each distinct request. Analyze new message for each distinct ask before using task tools. For each independent information-seeking question, if you can answer it directly, including greetings, trivial questions, or basic questions you can directly answer yourself, call direct_answer. If it requires some level of investigation, call start_research. For each clear independent request to change or implement code, call create_ticket with delegateToBearMetal=true. For an explicit request to open a ticket for the user or for later, without starting work, call create_ticket with delegateToBearMetal=false. Opening a ticket and starting work are distinct decisions: an unqualified "open a ticket" does not authorize implementation. If the user's work intent is unclear, call clarify_request before creating the ticket and ask whether Bear Metal should start working or only create the ticket. For update_task, preserve the existing coding task's delegateToBearMetal choice unless the user explicitly changes it; clarify ambiguous changes before updating. If a request directed at Bear Metal remains ambiguous after reading available context, call clarify_request with the specific question needed to understand it; the harness mentions the user in the Slack reply. Handle clear requests and ambiguous requests from the same message separately. One message can require multiple tasks; preserve the target and full details of each ask. Use the workspace read tools to understand unfamiliar references. An entry with kind "edit" revises the message identified by originalMessageTs; check tasks from that original message and call update_task or cancel_task if its request changed or was withdrawn. Use the edit entry's ts as sourceTs for task tools. If this batch contains the original or multiple edits of it, act on the latest edit. ${canIgnore ? "Acknowledge superseded entries with direct_answer when requiresResponse is true; otherwise use ignore_message." : "Acknowledge superseded entries with direct_answer."} Follow supersededBy links or use get_thread_task to find the current task after earlier edits. Give start_research the complete question and necessary context in request; quote is only a short label for Slack replies. Check the existing task summaries before creating a task: if a new message changes an existing task, call update_task; if it withdraws one, call cancel_task. For a research follow-up, send only the correction to update_task; it preserves the previous request automatically. For a Slack edit, send the complete edited request. Within the current group of new messages, follow the latest instruction before creating tasks. For example, if the group contains "Create a ticket for X" followed by "Never mind X", do not create a ticket for X; cancel_task if a task already exists. ${canIgnore ? "For superseded requests and withdrawals, use direct_answer when requiresResponse is true; otherwise use ignore_message when no action is needed." : "For superseded requests and withdrawals, use direct_answer when no task action is needed."} Make at least one decision for every message in this batch. The JSON messages array contains only current unprocessed messages, not earlier thread messages. Tasks created from previously processed messages appear in the task summaries. If a message refers to a previous request, changes it, or earlier messages could help interpret it in any way, call slack_read with operation "thread_replies" and parameters ${JSON.stringify({ channel: key.channelId, ts: key.threadTs })} to read the thread before deciding on an action. Do not guess from current messages or task summaries alone. Read all new messages in timestamp order before using task tools. Use get_thread_task when a task summary lacks needed detail. For truncated edit text, use get_message_revision; for other truncated text or messages with files or blocks, use slack_read before deciding. Use stable 1-based requestIndex values within each source message. The requiresResponse field is true for explicit mentions and every DM. Those messages must receive a response or action; never silently ignore them. ${canIgnore ? "For ordinary channel-thread messages where requiresResponse is false, use ignore_message when no Bear Metal action is needed, especially messages addressed to others. Do not insert unsolicited replies into their conversation. " : ""} Use direct_answer for conversational messages and clarify_request for unclear requests. Keep professional requests concise and helpful. For casual conversation, use humor and attitude when appropriate, such as "Fine, and how are you doing, amigo?" or "I'm all good, my friend". direct_answer sends your answer verbatim, without added formatting, reply wrappers, or user tags. When asked to stop bothering or following the thread, call unsubscribe_thread. This stops all further task messages, including results from work already in progress, without canceling that work. A later mention or DM resumes following. Do not post to Slack.\n${payload}`;
}

function researchResultPrompt(key: SlackThreadKey, task: SlackTaskRecord): string {
  return `Review the completed research result for task ${task.id}. Call get_thread_task with this ID to read its full request and answer. Call slack_read with operation "thread_replies" and parameters ${JSON.stringify({ channel: key.channelId, ts: key.threadTs })} to inspect the current conversation. Use earlier thread messages as context before deciding on an action. If you need more context to decide whether to approve the result, use slack_read again before making that decision. If the answer still addresses the latest request, call approve_research_result with this task ID. If the request was withdrawn or superseded, call cancel_task with this task ID. Make exactly one of those decisions. Do not post to Slack.`;
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
    github: GitHubIntegration;
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
      if (!await this.input.db.isSlackThreadFollowing(key)) return;
      const pending = await this.input.db.listSlackPendingMessages(key);
      if (pending.length > 0) {
        const pendingEdits = await this.input.db.listSlackPendingEdits(key);
        const editSources = new Map(pendingEdits.map((edit) => [edit.ts, edit.originalTs]));
        const newMessages = pending.filter((ts) => !editSources.has(ts));
        const thread = newMessages.length > 0 ? await this.input.api.readThread(key, newMessages[0]!) : [];
        const fetched = new Set(thread.map((message) => message.ts));
        let deletedOriginal = false;
        for (const originalTs of new Set(pending.map((ts) => editSources.get(ts)).filter((ts): ts is string => ts !== undefined))) {
          if (fetched.has(originalTs)) continue;
          const editedMessage = await this.input.api.readThread(key, originalTs, originalTs);
          if (editedMessage.length === 0) {
            await this.input.db.abandonSlackDeletedMessage(key.workspaceId, key.channelId, originalTs);
            this.input.logger.warn({ key, originalTs }, "Slack edit original was deleted; pending revisions abandoned");
            deletedOriginal = true;
            break;
          }
          if (editedMessage.length !== 1 || editedMessage[0]!.ts !== originalTs) throw new Error(`Slack thread ${key.channelId}/${key.threadTs} returned unexpected edited message ${originalTs}`);
          thread.push(editedMessage[0]!);
          fetched.add(originalTs);
        }
        if (deletedOriginal) continue;
        const latestSource = editSources.get(pending.at(-1)!) ?? pending.at(-1)!;
        if (!thread.some((message) => message.ts === latestSource)) throw new Error(`Slack thread ${key.channelId}/${key.threadTs} omitted latest pending message ${pending.at(-1)}`);
        for (const message of thread) {
          if (message.user && message.user !== this.input.botUserId && !message.botId && (!message.subtype || message.subtype === "file_share")) {
            await this.input.db.recordSlackMessage(key, message.ts);
          }
        }
        const availableTs = new Set(thread.map((message) => message.ts));
        const edits = await this.input.db.listSlackPendingEdits(key);
        const sources = new Map(edits.map((edit) => [edit.ts, edit.originalTs]));
        const batch = (await this.input.db.listSlackPendingMessages(key)).filter((ts) => availableTs.has(sources.get(ts) ?? ts));
        const latestBatchTs = batch.at(-1);
        if (!latestBatchTs) continue;
        const activation = await this.input.db.getSlackThreadActivation(key);
        const mentionTimestamps = new Set(activation.mentionTimestamps);
        const requiredResponses = new Set(batch.filter((ts) => {
          const edit = edits.find((entry) => entry.ts === ts);
          const message = thread.find((entry) => entry.ts === (edit?.originalTs ?? ts));
          return activation.directMessage || mentionTimestamps.has(edit?.originalTs ?? ts)
            || (edit?.text ?? message?.text ?? "").includes(`<@${this.input.botUserId}>`);
        }));
        const payload = buildCoordinatorPayload(key, batch, thread, await this.input.db.listSlackThreadTasks(key), edits, requiredResponses);
        const decisions = new Set<string>();
        let unsubscribeTs: string | undefined;
        const replies: CoordinationReply[] = [];
        const sourceUsers = new Map(thread.filter((message) => message.user).map((message) => [message.ts, message.user!]));
        for (const edit of edits) sourceUsers.set(edit.ts, edit.user);
        const tools = this.createTools(key, batch, undefined, decisions, sourceUsers, undefined, (reply) => replies.push(reply), (sourceTs) => { unsubscribeTs = sourceTs; }, requiredResponses);
        const task: Task = {
          type: "coordinator",
          id: randomUUID(),
          request: payload,
          slack: { ...key, sourceTs: latestBatchTs },
        };
        const assertDecisions = () => {
          const undecided = batch.filter((ts) => !decisions.has(ts) && (unsubscribeTs === undefined || ts <= unsubscribeTs));
          if (undecided.length > 0) throw new Error(`Coordinator made no decision for Slack messages: ${undecided.join(", ")}`);
        };
        await (this.input.runAgent ?? runSlackAgent)({
          task,
          db: this.input.db,
          config: this.input.config,
          gateway: this.input.gateway,
          getGithubToken: () => this.input.github.getInstallationToken(),
          tools,
          prompt: messagePrompt(key, payload, tools.some((tool) => tool.name === "ignore_message")),
          stopRequested: () => unsubscribeTs !== undefined,
          output: () => ({ replies: unsubscribeTs ? [] : replies.map((reply) => reply.text), decision: unsubscribeTs ? "Unsubscribed from this thread." : "Requests processed." }),
          validateOutcome: async () => assertDecisions(),
        });
        assertDecisions();
        await this.postCoordinationReply(key, batch, replies);
        await this.input.db.markSlackMessagesProcessed(key, batch.filter((ts) => decisions.has(ts)));
        if (unsubscribeTs !== undefined) continue;
      }
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      if (!await this.input.db.isSlackThreadFollowing(key)) return;
      if (await this.reviewResearchResults(key)) continue;
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      await this.postBatchReply(key);
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) continue;
      await this.postResearchAnswers(key);
      const remaining = await this.input.db.listSlackPendingMessages(key);
      if (remaining.length === 0) return;
    }
  }

  private async reviewResearchResults(key: SlackThreadKey): Promise<boolean> {
    const results = (await this.input.db.listSlackThreadTasks(key)).filter((task) => task.type === "research" && task.state === "awaiting_coordination");
    for (const result of results) {
      if (!await this.input.db.isSlackThreadFollowing(key, result.sourceTs)) continue;
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) return true;
      const current = await this.input.db.getSlackTask(result.id);
      if (!current || current.state !== "awaiting_coordination") continue;
      const request = JSON.stringify({ thread: key, resultTaskId: current.id, quote: current.quote, request: current.request, answer: current.result });
      let reviewDeferred = false;
      await (this.input.runAgent ?? runSlackAgent)({
        task: { type: "coordinator", id: randomUUID(), request, slack: { ...key, sourceTs: current.sourceTs } },
        db: this.input.db,
        config: this.input.config,
        gateway: this.input.gateway,
        getGithubToken: () => this.input.github.getInstallationToken(),
        tools: this.createTools(key, [], current.id, undefined, undefined, () => { reviewDeferred = true; }),
        prompt: researchResultPrompt(key, current),
        stopRequested: () => reviewDeferred,
        output: async () => {
          if (reviewDeferred) return { decision: "Research review deferred." };
          const reviewed = await this.input.db.getSlackTask(current.id);
          if (!reviewed) throw new Error(`Missing reviewed research task ${current.id}`);
          return { decision: `Research result ${reviewed.state}.` };
        },
        validateOutcome: async () => {
          if ((await this.input.db.listSlackPendingMessages(key)).length > 0) {
            reviewDeferred = true;
            return;
          }
          const decided = await this.input.db.getSlackTask(current.id);
          if (decided?.state !== "approved" && decided?.state !== "canceled") throw new Error(`Coordinator made no decision for research result ${current.id}`);
        },
      });
      if (reviewDeferred || (await this.input.db.listSlackPendingMessages(key)).length > 0) return true;
      const decided = await this.input.db.getSlackTask(current.id);
      if (decided?.state !== "approved" && decided?.state !== "canceled") throw new Error(`Coordinator made no decision for research result ${current.id}`);
    }
    return false;
  }

  private createTools(key: SlackThreadKey, pending: string[], resultTaskId?: string, decisions?: Set<string>, sourceUsers?: Map<string, string>, onReviewDeferred?: () => void, queueReply?: (reply: CoordinationReply) => void, onUnsubscribe?: (sourceTs: string) => void, requiredResponses: Set<string> = new Set()): ToolDefinition[] {
    let resultDetailsRead = false;
    const clarificationReplies = new Map<string, string>();
    const deferReviewIfPending = async () => {
      if ((await this.input.db.listSlackPendingMessages(key)).length === 0) return false;
      onReviewDeferred?.();
      return true;
    };
    const deferredResult = { content: [{ type: "text" as const, text: "Review deferred while newer Slack messages are processed." }], details: { deferred: true } };
    const requireSource = (sourceTs: string) => {
      if (!pending.includes(sourceTs)) throw new Error(`Message ${sourceTs} is not in this coordinator batch`);
      const user = sourceUsers?.get(sourceTs);
      if (!user) throw new Error(`Message ${sourceTs} has no verified Slack user`);
      return user;
    };
    const getTask = async (id: string) => {
      const task = await this.input.db.getSlackTask(id);
      if (!task || task.thread.workspaceId !== key.workspaceId || task.thread.channelId !== key.channelId || task.thread.threadTs !== key.threadTs) {
        throw new Error(`Task ${id} does not belong to this Slack thread`);
      }
      return task;
    };
    const assigneeFor = async (slackUserId: string) => this.input.linear.findUserIdByEmail(await this.input.api.getUserEmail(slackUserId));
    const createCoding = async (args: NewSlackTask & TicketInput & { slackTitle: string; delegateToBearMetal: boolean }) => {
      if (typeof args.delegateToBearMetal !== "boolean") throw new Error("Ticket creation requires an explicit delegation choice");
      const sourceUserId = requireSource(args.sourceTs);
      const assigneeId = await assigneeFor(sourceUserId);
      const { task, created } = await this.input.db.createSlackTask({ ...args, sourceUserId });
      if (!created) {
        if (task.ackState === null && task.state === "awaiting_coordination") {
          queueReply?.({ sourceTs: args.sourceTs, requestIndex: args.requestIndex, taskId: task.id, text: this.taskAcknowledgmentText(task, args.slackTitle) });
        } else if (task.ackState === null && task.state !== "failed" && task.state !== "canceled") {
          throw new Error(`Cannot replay coding task ${task.id} in state ${task.state}`);
        }
        decisions?.add(args.sourceTs);
        return { task, created: false };
      }
      try {
        const ticket = await this.input.linear.createSlackCodingTicket({ teamId: args.teamId, projectId: args.projectId, title: args.title, description: args.description, cycleId: args.cycleId, assigneeId });
        await this.input.db.attachSlackTicket(task.id, ticket.id, ticket.url);
        // Delegating before attachment lets the scheduler create a second row for this ticket.
        if (task.delegateToBearMetal) await this.input.linear.delegateSlackCodingTicket(ticket.id);
        const updated = await getTask(task.id);
        queueReply?.({ sourceTs: args.sourceTs, requestIndex: args.requestIndex, taskId: updated.id, text: this.taskAcknowledgmentText(updated, args.slackTitle) });
        decisions?.add(args.sourceTs);
        return { task: updated, created: true };
      } catch (err) {
        await this.input.db.failSlackTask(task.id, String(err));
        throw err;
      }
    };
    const createResearch = async (args: NewSlackTask) => {
      const sourceUserId = requireSource(args.sourceTs);
      const result = await this.input.db.createSlackTask({ ...args, sourceUserId });
      if (result.task.ackState === null) queueReply?.({ sourceTs: args.sourceTs, requestIndex: args.requestIndex, taskId: result.task.id, text: this.taskAcknowledgmentText(result.task) });
      if (result.created) this.input.wakeResearch();
      decisions?.add(args.sourceTs);
      return result;
    };
    const cancel = async (id: string, supersededBy?: string) => {
      const task = await getTask(id);
      if (task.state === "canceled") return task;
      if (task.type === "coding" && task.ticketId) {
        await this.input.linear.cancelSlackCodingTicket(task.ticketId);
      }
      await this.input.db.cancelSlackTask(id, supersededBy);
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
        if (resultTaskId && await deferReviewIfPending()) return deferredResult;
        if (!resultTaskId) {
          if (!params.sourceTs) throw new Error("Cancellation requires the source Slack message timestamp");
          requireSource(params.sourceTs);
        }
        const previous = await getTask(params.id);
        const canceled = await cancel(params.id);
        if (!resultTaskId && (requiredResponses.has(params.sourceTs!) || (!canceled.coordinatedAt && !canceled.ackState))) {
          const text = previous.state === "canceled"
            ? `Already canceled ${safeSlackLine(canceled.ticketUrl ?? canceled.quote ?? canceled.request.slice(0, 120))}`
            : this.taskAcknowledgmentText(canceled);
          const reply = await this.input.db.queueSlackCoordinationReply(key, { sourceTs: params.sourceTs!, requestIndex: 1_000_000, taskId: canceled.id, kind: "task_cancel", text });
          queueReply?.(reply);
        }
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
          if (await deferReviewIfPending()) return deferredResult;
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
        name: "get_message_revision",
        label: "Read Slack edit revision",
        description: "Read the complete saved text of a Slack edit in this coordinator batch. Use when an edit entry is truncated: slack_read shows the message's latest text, which may differ if it was edited again. Pass the edit entry's ts, not originalMessageTs.",
        parameters: Type.Object({ sourceTs: Type.String({ minLength: 1, description: "The edit entry's ts from the JSON messages array; this is its revision timestamp, not originalMessageTs." }) }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          const edit = (await this.input.db.listSlackPendingEdits(key)).find((item) => item.ts === params.sourceTs);
          if (!edit) throw new Error(`Slack edit ${params.sourceTs} is not pending`);
          return { content: [{ type: "text", text: JSON.stringify(edit) }], details: {} };
        },
      }),
      defineTool({
        name: "create_ticket",
        label: "Create ticket",
        description: "Use once per independent new ticket request. Persist its Slack source and create a Linear ticket assigned to the Slack requester. Delegate it to Bear Metal only when delegateToBearMetal=true. If intent to start work is unclear, use clarify_request before creating the ticket. Look up destinations only when needed to resolve the team or an optional project. Returns the task and ticket link.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message containing this request, from the JSON messages array. Example: '1712345678.000100'. Do not use the thread root timestamp unless it is the source message." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index among all independent requests in sourceTs, across coding, research, and clarification. For a ticket request followed by a research question in one message, use 1 and 2, not 1 twice." }),
          delegateToBearMetal: Type.Boolean({ description: "Required explicit work decision: true when the user wants Bear Metal to implement the request; false when they want only a ticket for themselves or later. Clarify unclear intent before calling." }),
          request: Type.String({ minLength: 1, description: "The user's complete coding request and relevant context, stored with the Slack task. The Linear worker receives description, so include the actionable requirements there too." }),
          teamId: Type.String({ minLength: 1, description: "Linear team ID for the team that should own the ticket. Use list_ticket_destinations if the team ID is unknown." }),
          projectId: Type.Optional(Type.String({ minLength: 1, description: "Optional Linear project ID. Include only when the requested work belongs to a specific project associated with teamId; otherwise omit. Use list_ticket_destinations if the project ID is unknown." })),
          title: Type.String({ minLength: 1, description: "Concise, human-readable Linear issue title describing the requested outcome." }),
          slackTitle: Type.String({ minLength: 1, description: "Short, natural phrase for the Slack ticket link, such as 'change startup to fast in A'. This is not stored or used as the Linear issue title." }),
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
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index among all independent requests in sourceTs, across coding, research, and clarification. For a ticket request followed by this question in one message, use 2." }),
          request: Type.String({ minLength: 1, description: "Complete research instruction sent directly to the research agent. Preserve the user's full question and necessary context; do not replace it with the short quote." }),
          quote: Type.String({ minLength: 1, description: "Short phrase identifying this question in Slack replies, such as 'all available hooks'. It is not the research prompt." }),
        }),
        execute: async (_id, params) => {
          const result = await createResearch({ ...params, type: "research", thread: key });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        },
      }),
      defineTool({
        name: "clarify_request",
        label: "Ask for clarification",
        description: "Use once per independent ambiguous request directed at Bear Metal, including when other requests in the same message are clear. Ask one specific question needed to understand the user's intent. This queues a clarification in the combined Slack reply; it does not create a coding or research task.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message containing the ambiguous request, from the JSON messages array." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index of this request among all independent coding, research, and clarification requests in sourceTs." }),
          question: Type.String({ minLength: 1, maxLength: 500, description: "The concise, specific question to ask the user. Do not include a user mention." }),
        }),
        execute: async (_id, params) => {
          const userId = requireSource(params.sourceTs);
          const actionKey = `${params.sourceTs}/${params.requestIndex}`;
          const existing = clarificationReplies.get(actionKey);
          if (existing && existing !== params.question) {
            throw new Error(`Clarification ${actionKey} was already requested with different content`);
          }
          if (!existing) {
            clarificationReplies.set(actionKey, params.question);
            const saved = await this.input.db.queueSlackCoordinationReply(key, { sourceTs: params.sourceTs, requestIndex: params.requestIndex, text: `<@${userId}>, ${safeSlackLine(params.question)}` });
            if (saved.state === "posting") throw new Error(`Reply ${actionKey} has unresolved delivery`);
            queueReply?.(saved);
          }
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: "Clarification queued for the combined thread reply." }], details: {} };
        },
      }),
      cancelTask,
      ...(pending.some((ts) => !requiredResponses.has(ts)) ? [defineTool({
        name: "ignore_message",
        label: "Ignore ordinary message",
        description: "Silently ignore an ordinary channel-thread message that needs no Bear Metal action, such as conversation addressed to someone else. Only allowed when requiresResponse is false. Explicit mentions and every DM require a response or action.",
        parameters: Type.Object({ sourceTs: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          if (requiredResponses.has(params.sourceTs)) throw new Error(`Message ${params.sourceTs} requires a response or action`);
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: `Ignored ordinary message: ${params.reason}` }], details: {} };
        },
      })] : []),
      defineTool({
        name: "direct_answer",
        label: "Answer directly",
        description: "Answer a message addressed to Bear Metal, such as a greeting, trivial question, or another request you can handle yourself. The answer is sent verbatim, without added formatting, reply wrappers, or user tags. Use casual humor and attitude when appropriate.",
        parameters: Type.Object({
          sourceTs: Type.String({ minLength: 1 }),
          requestIndex: Type.Integer({ minimum: 1 }),
          answer: Type.String({ minLength: 1 }),
        }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          if (!params.answer.trim()) throw new Error("Direct answer must contain text");
          const saved = await this.input.db.queueSlackCoordinationReply(key, { sourceTs: params.sourceTs, requestIndex: params.requestIndex, text: params.answer, direct: true });
          if (saved.state === "posting") throw new Error(`Direct answer ${params.sourceTs}/${params.requestIndex} has unresolved delivery`);
          queueReply?.(saved);
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: saved.state === "posted" ? "Direct answer already delivered." : `Direct answer queued: ${saved.text}` }], details: {} };
        },
      }),
      defineTool({
        name: "unsubscribe_thread",
        label: "Unsubscribe from thread",
        description: "Use when asked to stop bothering or following this thread. Suppresses all further task messages including in-flight results; work continues. A later mention or DM resumes following. Sends no reply.",
        parameters: Type.Object({ sourceTs: Type.String({ minLength: 1 }) }),
        execute: async (_id, params) => {
          requireSource(params.sourceTs);
          await this.input.db.unsubscribeSlackThread(key, params.sourceTs);
          for (const ts of pending) if (ts <= params.sourceTs) decisions?.add(ts);
          onUnsubscribe?.(params.sourceTs);
          return { content: [{ type: "text", text: "Unsubscribed from this thread." }], details: {} };
        },
      }),
      defineTool({
        name: "update_task",
        label: "Replace thread task",
        description: "Use when a new Slack message revises an existing task. Supersede the old task with a replacement from the new message. For research follow-up replies, provide only the correction, not a rewritten request: the saved request is carried forward automatically. For edits to the original Slack message, provide its complete new request instead. For coding replacements, provide the complete revised request, teamId, title, and description, plus projectId when a specific project applies.",
        parameters: Type.Object({
          id: Type.String({ minLength: 1, description: "ID of the existing task to replace, from the JSON tasks array or get_thread_task; not a Slack timestamp or Linear issue ID." }),
          sourceTs: Type.String({ minLength: 1, description: "Exact ts of the new Slack message that revises the task, from the JSON messages array." }),
          requestIndex: Type.Integer({ minimum: 1, description: "Stable 1-based index of this replacement among all independent requests in sourceTs, across coding and research. Never reuse another task's index from the same message." }),
          type: Type.Union([Type.Literal("coding"), Type.Literal("research")], { description: "Type of the replacement task: 'coding' creates a new delegated Linear ticket; 'research' starts a new research worker." }),
          request: Type.Optional(Type.String({ minLength: 1, description: "Complete revised instruction for a coding replacement or an edit to the original Slack message. Omit for a research follow-up reply." })),
          correction: Type.Optional(Type.String({ minLength: 1, description: "For a research follow-up reply, the user's correction to this task, without rewriting the prior request. Omit for coding replacements and Slack edits." })),
          quote: Type.Optional(Type.String({ minLength: 1, description: "Required when type='research': short identifying phrase for Slack replies, not the research instruction. Omit for coding." })),
          teamId: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': Linear team ID. Use list_ticket_destinations if unknown. Omit for research." })),
          projectId: Type.Optional(Type.String({ minLength: 1, description: "Optional when type='coding': Linear project ID whose teamIds includes teamId. Omit when no specific project applies or for research." })),
          title: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': concise title for the new Linear ticket. Omit for research." })),
          slackTitle: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': short natural phrase for the Slack ticket link. Omit for research." })),
          description: Type.Optional(Type.String({ minLength: 1, description: "Required when type='coding': complete instructions for the new Linear ticket, including the revised requirements. Omit for research." })),
          cycleId: Type.Optional(Type.String({ minLength: 1, description: "Optional Linear cycle ID for a coding replacement, only when the exact cycle is known. Omit for research or when unknown." })),
          delegateToBearMetal: Type.Optional(Type.Boolean({ description: "For coding replacements, omit to preserve the previous coding task delegation choice. Set only when the user explicitly changes whether Bear Metal should work; clarify unclear intent. Required when changing a research task into coding. Omit for research." })),
        }),
        execute: async (_id, params) => {
          const sourceUserId = requireSource(params.sourceTs);
          const previous = await getTask(params.id);
          const isEdit = (await this.input.db.listSlackPendingEdits(key)).some((edit) => edit.ts === params.sourceTs);
          let request: string;
          if (params.type === "research" && !isEdit) {
            if (!params.correction || params.request) throw new Error("Updated research task requires a correction, not a rewritten request");
            request = applyResearchCorrection(previous.request, params.correction);
          } else {
            if (!params.request || params.correction) throw new Error("Updated task requires a complete request without a correction");
            request = params.request;
          }
          let codingInput: TicketInput | undefined;
          if (params.type === "coding") {
            if (!params.teamId || !params.title || !params.description || !params.slackTitle) {
              throw new Error("Updated coding task requires Linear destination, title, Slack title, and description");
            }
            codingInput = {
              teamId: params.teamId, projectId: params.projectId, title: params.title,
              description: params.description, cycleId: params.cycleId,
              assigneeId: await assigneeFor(sourceUserId),
            };
          }
          const delegateToBearMetal = params.type === "coding" ? params.delegateToBearMetal ?? previous.delegateToBearMetal : undefined;
          if (params.type === "coding" && typeof delegateToBearMetal !== "boolean") throw new Error("Updated coding task requires an explicit delegation choice");
          if (params.type === "research" && params.delegateToBearMetal !== undefined) throw new Error("Research tasks cannot specify coding delegation");
          const next = await this.input.db.createSlackTask({
            ...(typeof delegateToBearMetal === "boolean" ? { delegateToBearMetal } : {}),
            type: params.type, thread: key, sourceTs: params.sourceTs, sourceUserId,
            requestIndex: params.requestIndex, request, quote: params.quote,
          });
          if (next.created) {
            try {
              await cancel(params.id, next.task.id);
              if (codingInput) {
                const ticket = await this.input.linear.createSlackCodingTicket(codingInput);
                await this.input.db.attachSlackTicket(next.task.id, ticket.id, ticket.url);
                if (next.task.delegateToBearMetal) await this.input.linear.delegateSlackCodingTicket(ticket.id);
                const updated = await getTask(next.task.id);
                queueReply?.({ sourceTs: params.sourceTs, requestIndex: params.requestIndex, taskId: updated.id, text: this.taskAcknowledgmentText(updated, params.slackTitle) });
              } else {
                queueReply?.({ sourceTs: params.sourceTs, requestIndex: params.requestIndex, taskId: next.task.id, text: this.taskAcknowledgmentText(next.task) });
                this.input.wakeResearch();
              }
            } catch (err) {
              await this.input.db.failSlackTask(next.task.id, String(err));
              throw err;
            }
          }
          if (!next.created && next.task.ackState === null) queueReply?.({ sourceTs: params.sourceTs, requestIndex: params.requestIndex, taskId: next.task.id, text: this.taskAcknowledgmentText(next.task, params.slackTitle) });
          decisions?.add(params.sourceTs);
          return { content: [{ type: "text", text: JSON.stringify(await getTask(next.task.id)) }], details: {} };
        },
      }),
    ];
  }

  private async postBatchReply(key: SlackThreadKey): Promise<void> {
    const tasks = await this.input.db.listSlackThreadTasks(key);
    const replies: CoordinationReply[] = [];
    for (const task of tasks) {
      if (task.ackState !== null || !await this.input.db.isSlackThreadFollowing(key, task.sourceTs)) continue;
      if (task.type === "coding" && task.state === "awaiting_coordination" ||
        task.type === "research" && ["queued", "running", "awaiting_coordination", "approved"].includes(task.state) ||
        task.state === "canceled" && !task.supersededBy && !task.coordinatedAt) {
        replies.push({ sourceTs: task.sourceTs, requestIndex: task.requestIndex, taskId: task.id, kind: task.state === "canceled" ? "task_cancel" : "task_ack", text: this.taskAcknowledgmentText(task, task.type === "coding" ? task.request.slice(0, 100) : undefined) });
      }
    }
    await this.postCoordinationReply(key, [...new Set(replies.map((reply) => reply.sourceTs))].sort(), replies);
  }

  private taskAcknowledgmentText(task: SlackTaskRecord, slackTitle?: string): string {
    if (task.state === "canceled") {
      return `Canceled ${safeSlackLine(task.ticketUrl ?? task.quote ?? task.request.slice(0, 120))}`;
    }
    if (task.type === "coding") {
      if (!task.ticketUrl || !slackTitle?.trim()) throw new Error(`Coding task ${task.id} is missing a ticket URL or Slack title`);
      return `Created a ticket for <${task.ticketUrl}|${safeSlackLine(slackTitle)}>${task.delegateToBearMetal ? " and assigned it to Bear Metal" : ""}.`;
    }
    if (!task.quote) throw new Error(`Research task ${task.id} has no question quote`);
    return `Looking into ${safeSlackLine(task.quote)}.`;
  }

  private async postCoordinationReply(key: SlackThreadKey, sourceOrder: string[], replies: CoordinationReply[]): Promise<void> {
    if (replies.length === 0 || !await this.input.db.isSlackThreadFollowing(key)) return;
    const distinct = new Map<string, CoordinationReply>();
    for (const reply of replies) {
      const actionKey = slackReplyKey(reply);
      const existing = distinct.get(actionKey);
      if (existing && (existing.text !== reply.text || existing.taskId !== reply.taskId || existing.direct !== reply.direct)) throw new Error(`Conflicting coordination replies for ${actionKey}`);
      distinct.set(actionKey, reply);
    }
    const ordered = [...distinct.values()].sort((a, b) => sourceOrder.indexOf(a.sourceTs) - sourceOrder.indexOf(b.sourceTs) || a.requestIndex - b.requestIndex || slackReplyKey(a).localeCompare(slackReplyKey(b)));
    const current = new Map((await this.input.db.listSlackThreadTasks(key)).map((task) => [task.id, task]));
    for (const reply of ordered) if (reply.taskId && !current.has(reply.taskId)) throw new Error(`Missing acknowledged task ${reply.taskId}`);
    const active: CoordinationReply[] = [];
    for (const reply of ordered) {
      if (!await this.input.db.isSlackThreadFollowing(key, reply.sourceTs) || (reply.kind !== "task_cancel" && reply.taskId && current.get(reply.taskId)?.supersededBy)) continue;
      const saved = await this.input.db.queueSlackCoordinationReply(key, reply);
      if (saved.state === "posted") continue;
      if (saved.state === "posting") throw new Error(`Reply ${reply.sourceTs}/${reply.requestIndex} has unresolved delivery`);
      active.push(saved);
    }
    if (active.length === 0) return;
    const groups: CoordinationReply[][] = [];
    for (const reply of active) {
      const previous = groups.at(-1);
      if (!reply.direct && previous && !previous[0]!.direct) previous.push(reply);
      else groups.push([reply]);
    }
    for (const group of groups) {
      const ids = group.flatMap((reply) => reply.taskId && current.get(reply.taskId)!.ackState === null && !current.get(reply.taskId)!.coordinatedAt ? [reply.taskId] : []);
      if (ids.length > 0) await this.input.db.beginSlackBatchAcknowledgment(ids);
      const groupKey = await this.input.db.beginSlackReplyGroup(key, group);
      let replyTs: string;
      try {
        replyTs = await this.input.api.reply(key, group.map((reply) => reply.text).join("\n\n"));
      } catch (err) {
        const rejected = err instanceof SlackThreadReplyRejectedError;
        await this.input.db.finishSlackReplyGroup(key, groupKey, rejected ? "rejected" : "uncertain", null, String(err));
        if (rejected && ids.length > 0) await this.input.db.failSlackBatchAcknowledgment(ids, String(err));
        throw err;
      }
      await this.input.db.finishSlackReplyGroup(key, groupKey, "posted", replyTs, null);
      for (const id of ids) {
        const task = current.get(id);
        if (!task) throw new Error(`Missing acknowledged task ${id}`);
        if (task.type === "research" && task.state !== "canceled") await this.input.db.markSlackResearchStartedReply(id, replyTs);
        else await this.input.db.markSlackTaskCoordinated(id, replyTs);
      }
    }
  }

  private async postResearchAnswers(key: SlackThreadKey): Promise<void> {
    const tasks = await this.input.db.listSlackThreadTasks(key);
    for (const task of tasks) {
      if (task.type !== "research" || task.state !== "approved" || !await this.input.db.isSlackThreadFollowing(key, task.sourceTs)) continue;
      if ((await this.input.db.listSlackPendingMessages(key)).length > 0) return;
      const current = await this.input.db.getSlackTask(task.id);
      if (!current || current.state !== "approved") continue;
      if (!current.result || !current.quote) throw new Error(`Completed research task ${task.id} is missing answer or quote`);
      let sourceUserId = current.sourceUserId;
      if (!sourceUserId) {
        const source = await this.input.api.readThread(key, current.sourceTs, current.sourceTs);
        sourceUserId = source.find((message) => message.ts === current.sourceTs)?.user ?? null;
      }
      if (!sourceUserId) throw new Error(`Research task ${task.id} has no source Slack user`);
      await this.input.db.beginSlackTaskReply(task.id);
      try {
        const replyTs = current.summary
          ? await this.input.api.replyResearch(key, sourceUserId, current.quote, current.result, current.summary)
          : await this.input.api.replyResearch(key, sourceUserId, current.quote, current.result);
        await this.input.db.markSlackTaskCoordinated(task.id, replyTs);
      } catch (err) {
        await this.input.db.failSlackTask(task.id, String(err));
        throw err;
      }
    }
  }
}
