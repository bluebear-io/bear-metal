import { describe, expect, it, vi } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import type { SlackThreadApi } from "./slack-thread-api.js";
import { SlackCoordinator } from "./slack-coordinator.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "100.0" };

async function makeDb() {
  const db = new SqlDbClient("sqlite::memory:", 5);
  await db.initSchema();
  await db.followSlackThread(key, "100.1");
  return db;
}

function makeApi(messages: Array<{ ts: string; user: string; text: string }>) {
  const replies: string[] = [];
  const api = {
    readThread: vi.fn(async () => messages),
    getUserEmail: vi.fn(async () => "user@example.com"),
    reply: vi.fn(async (_key: SlackThreadKey, text: string) => {
      replies.push(text);
      return `reply-${replies.length}`;
    }),
    replyResearch: vi.fn(async (_key: SlackThreadKey, userId: string, quote: string, answer: string) => {
      replies.push(`Replying to <@${userId}>\n> ${quote}\n\n${answer}`);
      return `reply-${replies.length}`;
    }),
  } as unknown as SlackThreadApi;
  return { api, replies };
}

function makeCoordinator(input: {
  db: SqlDbClient;
  api: SlackThreadApi;
  runAgent: NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]>;
  linear?: Partial<LinearIntegration>;
  wakeResearch?: () => void;
}) {
  return new SlackCoordinator({
    db: input.db, api: input.api,
    botUserId: "UBOT",
    linear: { findUserIdByEmail: async () => "linear-user-1", ...input.linear } as LinearIntegration,
    github: { getInstallationToken: async () => "token" } as ConstructorParameters<typeof SlackCoordinator>[0]["github"],
    config: {} as ConstructorParameters<typeof SlackCoordinator>[0]["config"],
    logger: createLogger({ name: "test", level: "silent" }),
    pollIntervalMs: 60_000, wakeResearch: input.wakeResearch ?? (() => {}), runAgent: input.runAgent,
  });
}

describe("Slack coordinator", () => {
  it("abandons a pending edit whose original message was deleted and continues with later replies", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Edited, then deleted");
    await db.recordSlackMessage(key, "100.3");
    const api = {
      readThread: vi.fn(async (_key: SlackThreadKey, oldest: string, latest?: string) => {
        if (oldest === "100.3" && latest === undefined) return [{ ts: "100.3", user: "U1", text: "New request" }];
        if (oldest === "100.1" && latest === "100.1") return [];
        throw new Error(`Unexpected Slack read ${oldest}/${latest}`);
      }),
      reply: vi.fn(),
    } as unknown as SlackThreadApi;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const ignore = tools.find((tool) => tool.name === "ignore_message");
      if (!ignore) throw new Error("ignore_message missing");
      await ignore.execute("ignore", { sourceTs: "100.3", reason: "test" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackPendingEdits(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("bounds old edits while backfilling gaps after pending new replies", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Edited request");
    await db.recordSlackMessage(key, "100.8");
    const api = {
      readThread: vi.fn(async (_key: SlackThreadKey, oldest: string, latest?: string) => {
        if (oldest === "100.1" && latest === "100.1") return [{ ts: "100.1", user: "U1", text: "Edited request" }];
        if (oldest === "100.8" && latest === undefined) return [
          { ts: "100.8", user: "U1", text: "Pending" },
          { ts: "100.9", user: "U1", text: "Gap reply" },
        ];
        throw new Error(`Unexpected Slack read ${oldest}/${latest}`);
      }),
      reply: vi.fn(),
    } as unknown as SlackThreadApi;
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const messages = (JSON.parse(task.request) as { messages: Array<{ ts: string }> }).messages;
      batches.push(messages.map((message) => message.ts));
      const ignore = tools.find((tool) => tool.name === "ignore_message");
      if (!ignore) throw new Error("ignore_message missing");
      for (const message of messages) await ignore.execute(`ignore-${message.ts}`, { sourceTs: message.ts, reason: "test" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(vi.mocked(api.readThread)).toHaveBeenNthCalledWith(1, key, "100.8");
      expect(vi.mocked(api.readThread)).toHaveBeenNthCalledWith(2, key, "100.1", "100.1");
      expect(batches).toEqual([["100.2", "100.8", "100.9"]]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("replaces a processed request from a Slack edit and reads from the original message", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const oldTask = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find old answer", quote: "old answer" })).task;
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Find new answer");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Find new answer" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const payload = JSON.parse(task.request) as { messages: Array<{ ts: string; kind: string; originalMessageTs: string; text: string; readReference: { messageTs: string } }> };
      expect(payload.messages).toEqual([expect.objectContaining({ ts: "100.2", kind: "edit", originalMessageTs: "100.1", text: "Find new answer", readReference: expect.objectContaining({ messageTs: "100.1" }) })]);
      const revision = tools.find((tool) => tool.name === "get_message_revision");
      if (!revision) throw new Error("get_message_revision missing");
      expect(await revision.execute("revision", { sourceTs: "100.2" }, undefined, undefined, {} as never)).toEqual(expect.objectContaining({ content: [{ type: "text", text: JSON.stringify({ ts: "100.2", originalTs: "100.1", user: "U1", text: "Find new answer" }) }] }));
      const update = tools.find((tool) => tool.name === "update_task");
      if (!update) throw new Error("update_task missing");
      await update.execute("update", { id: oldTask.id, sourceTs: "100.2", requestIndex: 1, type: "research", request: "Find new answer", quote: "new answer" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(vi.mocked(api.readThread)).toHaveBeenCalledWith(key, "100.1", "100.1");
      expect(vi.mocked(api.readThread)).toHaveBeenCalledTimes(1);
      expect((await db.getSlackTask(oldTask.id))?.state).toBe("canceled");
      expect((await db.listSlackThreadTasks(key)).find((task) => task.sourceTs === "100.2")?.request).toBe("Find new answer");
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("preserves the original research scope across successive Slack corrections", async () => {
    const db = await makeDb();
    const original = "Count external sub-repositories cloned by scripts/clone-repos.sh; use AGENTS.md Repository map.";
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: original, quote: "external repositories" })).task;
    await db.recordSlackMessage(key, "100.2");
    const { api } = makeApi([
      { ts: "100.2", user: "U1", text: "Only those with a in their name" },
      { ts: "100.3", user: "U1", text: "Sorry, h instead" },
    ]);
    let finalRequest: string | undefined;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const update = tools.find((tool) => tool.name === "update_task");
      if (!update) throw new Error("update_task missing");
      const second = await update.execute("v2", {
        id: old.id, sourceTs: "100.2", requestIndex: 1, type: "research",
        correction: "Only those with a in their name", quote: "repositories with a",
      }, undefined, undefined, {} as never);
      const secondContent = second.content[0];
      if (secondContent?.type !== "text") throw new Error("update_task returned no task");
      const secondId = (JSON.parse(secondContent.text) as { id: string }).id;
      const third = await update.execute("v3", {
        id: secondId, sourceTs: "100.3", requestIndex: 1, type: "research",
        correction: "Sorry, h instead", quote: "repositories with h",
      }, undefined, undefined, {} as never);
      const thirdContent = third.content[0];
      if (thirdContent?.type !== "text") throw new Error("update_task returned no task");
      const thirdId = (JSON.parse(thirdContent.text) as { id: string }).id;
      finalRequest = (await db.getSlackTask(thirdId))?.request;
    } });
    try {
      await coordinator.wake(key);
      expect(finalRequest).toContain(original);
      expect(finalRequest).toContain("Only those with a in their name");
      expect(finalRequest).toContain("Sorry, h instead");
      expect(finalRequest).toContain("Later corrections override earlier conflicting details");
    } finally {
      await db.close();
    }
  });
  it("cancels a task when its source message is edited to withdraw the request", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const oldTask = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find answer", quote: "answer" })).task;
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Never mind");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Never mind" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const cancel = tools.find((tool) => tool.name === "cancel_task");
      if (!cancel) throw new Error("cancel_task missing");
      await cancel.execute("cancel", { id: oldTask.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect((await db.getSlackTask(oldTask.id))?.state).toBe("canceled");
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("fills gaps between pending replies from a bounded read", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.100000");
    await db.recordSlackMessage(key, "100.100000");
    await db.recordSlackMessage(key, "100.400000");
    const thread = [
      { ts: "100.100000", user: "U1", text: "mention" },
      { ts: "100.300000", user: "U1", text: "pending" },
      { ts: "100.400000", user: "U1", text: "new reply" },
      { ts: "100.500000", user: "U2", botId: "B1", text: "bot" },
      { ts: "100.600000", user: "UBOT", text: "self" },
      { ts: "100.700000", user: "U3", subtype: "message_changed", text: "edit" },
      { ts: "100.800000", user: "U4", subtype: "file_share", text: "file" },
    ];
    const api = { readThread: vi.fn(async () => {
      await db.recordSlackMessage(key, "100.800000");
      return thread;
    }), reply: vi.fn() } as unknown as SlackThreadApi;
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const messages = (JSON.parse(task.request) as { messages: Array<{ ts: string }> }).messages;
      batches.push(messages.map((message) => message.ts));
      const ignore = tools.find((tool) => tool.name === "ignore_message");
      if (!ignore) throw new Error("ignore_message missing");
      for (const message of messages) await ignore.execute(`ignore-${message.ts}`, { sourceTs: message.ts, reason: "test" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(vi.mocked(api.readThread)).toHaveBeenCalledWith(key, "100.100000");
      expect(batches).toEqual([["100.100000", "100.300000", "100.400000", "100.800000"]]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("leaves a message pending when the agent makes no task decision", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Research this" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async () => {} });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
    } finally {
      await db.close();
    }
  });

  it("processes a message only after an explicit no-task decision", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Thanks" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      expect(prompt).toContain("entire message is clearly non-actionable for Bear Metal");
      const ignore = tools.find((tool) => tool.name === "ignore_message");
      if (!ignore) throw new Error("ignore_message missing");
      expect(ignore.description).toContain("entire message is clearly non-actionable for Bear Metal");
      await ignore.execute("ignore", { sourceTs: "100.1", reason: "No request" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackThreadTasks(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("asks a specific clarification and processes the source message", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> make me a pizza please" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      expect(prompt).toContain("clarify_request");
      const clarify = tools.find((tool) => tool.name === "clarify_request");
      if (!clarify) throw new Error("clarify_request missing");
      await clarify.execute("clarify", {
        sourceTs: "100.1", requestIndex: 1, quote: "make me a pizza please",
        question: "What code change, if any, do you mean by this?",
      }, undefined, undefined, {} as never);
      expect(replies).toEqual([]);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["<@U1>\n> make me a pizza please\n\nWhat code change, if any, do you mean by this?"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackThreadTasks(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("leaves clarification pending when the Slack reply fails", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> make me a pizza" }]);
    vi.mocked(api.reply).mockRejectedValueOnce(new Error("Slack unavailable"));
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const clarify = tools.find((tool) => tool.name === "clarify_request");
      if (!clarify) throw new Error("clarify_request missing");
      await clarify.execute("clarify", {
        sourceTs: "100.1", requestIndex: 1, quote: "make me a pizza",
        question: "What code change do you mean by this?",
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
    } finally {
      await db.close();
    }
  });

  it("retries the combined reply without creating duplicate tickets after Slack fails", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Change A and explain B" }]);
    vi.mocked(api.reply).mockRejectedValueOnce(new Error("Slack unavailable"));
    const create = vi.fn(async () => ({ id: "A", url: "https://linear.app/ticket/A", identifier: "A" }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() },
      runAgent: async ({ tools }) => {
        const ticket = tools.find((tool) => tool.name === "create_ticket");
        const research = tools.find((tool) => tool.name === "start_research");
        if (!ticket || !research) throw new Error("Task tools missing");
        await ticket.execute("a", { sourceTs: "100.1", requestIndex: 1, request: "Change A", teamId: "team", title: "A", slackTitle: "change A", description: "Change A" }, undefined, undefined, {} as never);
        await research.execute("b", { sourceTs: "100.1", requestIndex: 2, request: "Explain B", quote: "why B is slow" }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A>.\n\nLooking into why B is slow."]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("creates clear tasks and clarifies a separate ambiguous ask in the same message", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Change A, change B, and make me a pizza" }]);
    const create = vi.fn(async (input: { title: string }) => ({ id: input.title, url: `https://linear.app/ticket/${input.title}`, identifier: input.title }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() },
      runAgent: async ({ tools }) => {
        const ticket = tools.find((tool) => tool.name === "create_ticket");
        const clarify = tools.find((tool) => tool.name === "clarify_request");
        if (!ticket || !clarify) throw new Error("Task or clarification tool missing");
        for (const [index, title] of ["A", "B"].entries()) {
          await ticket.execute(`ticket-${index}`, {
            sourceTs: "100.1", requestIndex: index + 1, request: `Change ${title}`,
            teamId: "team", title, slackTitle: `change ${title}`, description: `Change ${title}`,
          }, undefined, undefined, {} as never);
        }
        await clarify.execute("clarify", {
          sourceTs: "100.1", requestIndex: 3, quote: "make me a pizza",
          question: "What change do you want Bear Metal to make?",
        }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(2);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A>.\n\nCreated a ticket for <https://linear.app/ticket/B|change B>.\n\n<@U1>\n> make me a pizza\n\nWhat change do you want Bear Metal to make?"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await db.listSlackThreadTasks(key)).map((task) => task.type)).toEqual(["coding", "coding"]);
    } finally {
      await db.close();
    }
  });

  it("keeps research runnable when its acknowledgment fails", async () => {
    const db = await makeDb();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", sourceUserId: "U1", requestIndex: 1, request: "Find A", quote: "Find A" })).task;
    const { api } = makeApi([]);
    vi.mocked(api.reply).mockRejectedValueOnce(new Error("Slack unavailable"));
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const detail = tools.find((tool) => tool.name === "get_thread_task");
      const approval = tools.find((tool) => tool.name === "approve_research_result");
      if (!detail || !approval) throw new Error("Research review tools missing");
      await detail.execute("detail", { id: task.id }, undefined, undefined, {} as never);
      await approval.execute("approve", { id: task.id }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect((await db.getSlackTask(task.id))?.state).toBe("queued");
      expect((await db.claimSlackResearchTask())?.id).toBe(task.id);
      await db.completeSlackResearchTask(task.id, "Answer A");
      expect((await db.getSlackTask(task.id))?.result).toBe("Answer A");
      await coordinator.wake(key);
      expect((await db.getSlackTask(task.id))?.state).toBe("coordinated");
      expect(vi.mocked(api.replyResearch)).toHaveBeenCalledWith(key, "U1", "Find A", "Answer A");
    } finally {
      await db.close();
    }
  });
  it("creates separate tickets from one message and replies once", async () => {
    const db = await makeDb();
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Please do A and B" }]);
    await db.recordSlackMessage(key, "100.1");
    const create = vi.fn(async (input: { title: string }) => ({ id: input.title, url: `https://linear.app/ticket/${input.title}`, identifier: input.title }));
    const delegate = vi.fn(async (ticketId: string) => {
      const task = (await db.listSlackThreadTasks(key)).find((candidate) => candidate.ticketId === ticketId);
      expect(task?.ticketUrl).toBe(`https://linear.app/ticket/${ticketId}`);
    });
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: delegate },
      runAgent: async ({ tools, prompt }) => {
        expect(prompt).toContain("create_ticket");
        expect(prompt).toContain("start_research");
        expect(prompt).toContain("only current unprocessed messages");
        expect(prompt).toContain("slack_read");
        expect(prompt).toContain('"thread_replies"');
        expect(prompt).toContain(JSON.stringify({ channel: key.channelId, ts: key.threadTs }));
        expect(prompt).toContain("before deciding on an action");
        expect(tools.some((candidate) => candidate.name === "approve_research_result")).toBe(false);
        const tool = tools.find((candidate) => candidate.name === "create_ticket");
        if (!tool) throw new Error("create_ticket missing");
        for (const [index, title] of ["A", "B"].entries()) {
          await tool.execute(`call-${index}`, {
            sourceTs: "100.1", requestIndex: index + 1, request: title,
            teamId: "team", projectId: "project", title, slackTitle: title, description: title,
          }, undefined, undefined, {} as never);
        }
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project", assigneeId: "linear-user-1" }));
      expect(delegate).toHaveBeenCalledTimes(2);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|A>.\n\nCreated a ticket for <https://linear.app/ticket/B|B>."]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await db.listSlackThreadTasks(key)).map((task) => task.state)).toEqual(["coordinated", "coordinated"]);
    } finally {
      await db.close();
    }
  });

  it("creates a Linear ticket without a project when none applies", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Create a ticket" }]);
    const create = vi.fn(async () => ({ id: "linear-1", url: "https://linear.app/ticket/1", identifier: "DEN-1" }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() },
      runAgent: async ({ tools }) => {
        const tool = tools.find((candidate) => candidate.name === "create_ticket");
        if (!tool) throw new Error("create_ticket missing");
        await tool.execute("ticket", { sourceTs: "100.1", requestIndex: 1, request: "Create a ticket", teamId: "team", title: "Ticket", slackTitle: "create a ticket", description: "Task" }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ projectId: expect.anything() }));
      expect((await db.listSlackThreadTasks(key))[0]?.state).toBe("coordinated");
    } finally {
      await db.close();
    }
  });

  it("cancels an old ticket before creating its replacement without a cancellation reply", async () => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "coding", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Implement A" })).task;
    await db.attachSlackTicket(old.id, "old-ticket", "https://linear.app/old");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "Implement B instead" }]);
    const order: string[] = [];
    const cancel = vi.fn(async (id: string) => { order.push(`cancel ${id}`); });
    const create = vi.fn(async () => { order.push("create new"); return { id: "new-ticket", url: "https://linear.app/new", identifier: "DEN-2" }; });
    const delegate = vi.fn(async () => { order.push("delegate new"); });
    const coordinator = makeCoordinator({ db, api, linear: { cancelSlackCodingTicket: cancel, createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent: async ({ tools }) => {
      const update = tools.find((tool) => tool.name === "update_task");
      if (!update) throw new Error("update_task missing");
      await update.execute("update", {
        id: old.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Implement B",
        teamId: "team", title: "B", slackTitle: "implement B", description: "Implement B",
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(order).toEqual(["cancel old-ticket", "create new", "delegate new"]);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|implement B>."]);
      expect((await db.getSlackTask(old.id))?.state).toBe("canceled");
      expect(await db.listSlackPendingThreads()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("posts a cancellation without a colon", async () => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find repositories", quote: "repos with 'h' in name" })).task;
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "Cancel that" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const cancel = tools.find((tool) => tool.name === "cancel_task");
      if (!cancel) throw new Error("cancel_task missing");
      await cancel.execute("cancel", { id: old.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Canceled repos with 'h' in name"]);
    } finally {
      await db.close();
    }
  });

  it("posts coding and research acknowledgments in one reply after coordination ends", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Change A, explain B, and change C" }]);
    const create = vi.fn(async (input: { title: string }) => ({ id: input.title, url: `https://linear.app/ticket/${input.title}`, identifier: input.title }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() },
      runAgent: async ({ tools }) => {
        const ticket = tools.find((tool) => tool.name === "create_ticket");
        const research = tools.find((tool) => tool.name === "start_research");
        if (!ticket || !research) throw new Error("Task tools missing");
        await ticket.execute("a", { sourceTs: "100.1", requestIndex: 1, request: "Change A", teamId: "team", title: "A", slackTitle: "change A", description: "Change A" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
        await research.execute("b", { sourceTs: "100.1", requestIndex: 2, request: "Explain B", quote: "why B is slow" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
        await ticket.execute("c", { sourceTs: "100.1", requestIndex: 3, request: "Change C", teamId: "team", title: "C", slackTitle: "change C", description: "Change C" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
      },
    });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A>.\n\nLooking into why B is slow.\n\nCreated a ticket for <https://linear.app/ticket/C|change C>."]);
      expect((await db.listSlackThreadTasks(key))[1]?.sourceUserId).toBe("U1");
    } finally {
      await db.close();
    }
  });

  it("processes a correction before posting a superseded research result", async () => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find A", quote: "Find A" })).task;
    await db.claimSlackResearchTask();
    await db.completeSlackResearchTask(old.id, "Old answer");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Find A" }, { ts: "100.2", user: "U1", text: "Never mind A" }]);
    const coordinator = makeCoordinator({
      db, api,
      runAgent: async ({ tools }) => {
        const tool = tools.find((candidate) => candidate.name === "cancel_task");
        if (!tool) throw new Error("cancel_task missing");
        await tool.execute("cancel", { id: old.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(replies.join("\n")).not.toContain("Old answer");
      expect((await db.getSlackTask(old.id))?.state).toBe("canceled");
    } finally {
      await db.close();
    }
  });

  it("posts a completed research answer after coordinator review", async () => {
    const db = await makeDb();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", sourceUserId: "U1", requestIndex: 1, request: "Find A", quote: "Find A" })).task;
    await db.claimSlackResearchTask();
    await db.completeSlackResearchTask(task.id, "Answer A", "Summary A");
    const { api, replies } = makeApi([]);
    const runAgent = vi.fn(async ({ tools, prompt }: Parameters<NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]>>[0]) => {
      expect(prompt).toContain("get_thread_task");
      expect(prompt).toContain("approve_research_result");
      expect(prompt).toContain("earlier thread messages");
      expect(prompt).toContain("before deciding on an action");
      expect(prompt).toContain("If you need more context to decide whether to approve the result, use slack_read again");
      expect(tools.some((tool) => tool.name === "create_ticket")).toBe(false);
      const detail = tools.find((tool) => tool.name === "get_thread_task");
      const approval = tools.find((tool) => tool.name === "approve_research_result");
      if (!detail || !approval) throw new Error("Research review tools missing");
      await expect(approval.execute("early", { id: task.id }, undefined, undefined, {} as never)).rejects.toThrow("Read task details");
      await detail.execute("detail", { id: task.id }, undefined, undefined, {} as never);
      await approval.execute("approve", { id: task.id }, undefined, undefined, {} as never);
    });
    const coordinator = makeCoordinator({ db, api, runAgent });
    try {
      await coordinator.wake(key);
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(replies).toEqual(["Looking into Find A.", "Replying to <@U1>\n> Find A\n\nAnswer A"]);
      expect(vi.mocked(api.replyResearch)).toHaveBeenCalledWith(key, "U1", "Find A", "Answer A", "Summary A");
      expect((await db.getSlackTask(task.id))?.state).toBe("coordinated");
    } finally {
      await db.close();
    }
  });

  it("does not post a research answer without an explicit coordinator decision", async () => {
    const db = await makeDb();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find A", quote: "Find A" })).task;
    await db.claimSlackResearchTask();
    await db.completeSlackResearchTask(task.id, "Answer A");
    const { api, replies } = makeApi([]);
    const coordinator = makeCoordinator({ db, api, runAgent: async () => {} });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual([]);
      expect((await db.getSlackTask(task.id))?.state).toBe("awaiting_coordination");
    } finally {
      await coordinator.stop();
      await db.close();
    }
  });

  it("defers a review and starts replacement research immediately when a message arrives", async () => {
    const db = await makeDb();
    const task = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find A", quote: "Find A" })).task;
    await db.claimSlackResearchTask();
    await db.completeSlackResearchTask(task.id, "Answer A");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Find A" }, { ts: "100.2", user: "U1", text: "Find B instead" }]);
    const wakeResearch = vi.fn();
    let replacementStarted = false;
    const coordinator = makeCoordinator({
      db, api, wakeResearch,
      runAgent: async ({ tools, prompt, stopRequested, validateOutcome }) => {
        if (prompt.startsWith("Review the completed research result")) {
          const detail = tools.find((tool) => tool.name === "get_thread_task");
          const approval = tools.find((tool) => tool.name === "approve_research_result");
          if (!detail || !approval) throw new Error("Research review tools missing");
          await detail.execute("detail", { id: task.id }, undefined, undefined, {} as never);
          await db.recordSlackMessage(key, "100.2");
          const decision = await approval.execute("approve", { id: task.id }, undefined, undefined, {} as never);
          expect(decision).toMatchObject({ details: { deferred: true } });
          expect(stopRequested?.()).toBe(true);
          await validateOutcome?.();
          return;
        }
        const update = tools.find((tool) => tool.name === "update_task");
        if (!update) throw new Error("update_task missing");
        await update.execute("update", { id: task.id, sourceTs: "100.2", requestIndex: 1, type: "research", correction: "Find B instead", quote: "Find B" }, undefined, undefined, {} as never);
        replacementStarted = true;
      },
    });
    try {
      await coordinator.wake(key);
      expect(replies.join("\n")).not.toContain("Answer A");
      expect((await db.getSlackTask(task.id))?.state).toBe("canceled");
      expect(replacementStarted).toBe(true);
      expect(wakeResearch).toHaveBeenCalledTimes(1);
      expect((await db.listSlackThreadTasks(key)).find((item) => item.sourceTs === "100.2")?.state).toBe("queued");
    } finally {
      await db.close();
    }
  });

  it("posts a persisted ticket link after a missed wake without creating another ticket", async () => {
    const db = await makeDb();
    const task = (await db.createSlackTask({ type: "coding", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Create ticket" })).task;
    await db.attachSlackTicket(task.id, "linear-1", "https://linear.app/ticket/1");
    const { api, replies } = makeApi([]);
    const create = vi.fn();
    const runAgent = vi.fn(async () => {});
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create }, runAgent });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/1|Create ticket>."]);
      expect(create).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect((await db.getSlackTask(task.id))?.state).toBe("coordinated");
    } finally {
      await db.close();
    }
  });

  it("does not retry an uncertain Linear creation result for the same request", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Create ticket" }]);
    const create = vi.fn(async () => { throw new Error("Linear response lost"); });
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create },
      runAgent: async ({ tools }) => {
        const tool = tools.find((candidate) => candidate.name === "create_ticket");
        if (!tool) throw new Error("create_ticket missing");
        const args = { sourceTs: "100.1", requestIndex: 1, request: "Create ticket", teamId: "team", projectId: "project", title: "Ticket", description: "Task" };
        await expect(tool.execute("first", args, undefined, undefined, {} as never)).rejects.toThrow("Linear response lost");
        await tool.execute("replay", args, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([]);
      expect((await db.listSlackThreadTasks(key))[0]?.state).toBe("failed");
    } finally {
      await db.close();
    }
  });

  it("rejects an incomplete coding replacement before changing the existing task", async () => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Research X", quote: "Research X" })).task;
    await db.recordSlackMessage(key, "100.2");
    const { api } = makeApi([{ ts: "100.2", user: "U1", text: "Create a coding ticket instead" }]);
    const coordinator = makeCoordinator({
      db, api,
      runAgent: async ({ tools }) => {
        const update = tools.find((tool) => tool.name === "update_task");
        if (!update) throw new Error("update_task missing");
        await expect(update.execute("update", {
          id: old.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Implement X",
        }, undefined, undefined, {} as never)).rejects.toThrow("requires Linear destination");
      },
    });
    try {
      await coordinator.wake(key);
      expect((await db.getSlackTask(old.id))?.state).toBe("queued");
      expect(await db.listSlackThreadTasks(key)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
