import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import { SlackIntegration, SlackThreadReplyRejectedError, type SlackReadClient } from "../shared/integrations/slack/client.js";
import { SlackThreadApi } from "./slack-thread-api.js";
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
    readThreadMessage: vi.fn(async (_key: SlackThreadKey, ts: string) => messages.find((message) => message.ts === ts) ?? null),
    getUserEmail: vi.fn(async () => "user@example.com"),
    react: vi.fn(async () => {}),
    reply: vi.fn(async (_key: SlackThreadKey, text: string) => {
      replies.push(text);
      return `reply-${replies.length}`;
    }),
    replyResearch: vi.fn(async (_key: SlackThreadKey, userId: string, quote: string, answer: string) => {
      replies.push(`Replying to <@${userId}>'s "${quote}"\n\n${answer}`);
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
  logger?: ReturnType<typeof createLogger>;
}) {
  return new SlackCoordinator({
    db: input.db, api: input.api,
    botUserId: "UBOT",
    linear: { findUserIdByEmail: async () => "linear-user-1", ...input.linear } as LinearIntegration,
    github: { getInstallationToken: async () => "token" } as ConstructorParameters<typeof SlackCoordinator>[0]["github"],
    config: {} as ConstructorParameters<typeof SlackCoordinator>[0]["config"],
    logger: input.logger ?? createLogger({ name: "test", level: "silent" }),
    pollIntervalMs: 60_000, wakeResearch: input.wakeResearch ?? (() => {}), runAgent: input.runAgent,
  });
}

describe("Slack coordinator", () => {
  it("requires destination lookup consistently in the prompt and ticket tools", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> open a ticket for later" }]);
    const destinations = { teams: [{ id: "team-new", key: "DEN", name: "Engineering" }], projects: [{ id: "project-new", name: "Project", teamIds: ["team-new"] }], cycles: [{ id: "cycle-new", teamId: "team-new", name: "Cycle", number: 1, startsAt: "2026-10-01", endsAt: "2026-10-15" }] };
    const lookup = vi.fn(async () => destinations);
    const create = vi.fn(async () => ({ id: "new-ticket", url: "https://linear.app/new", identifier: "DEN-2" }));
    let actualPrompt = "";
    const descriptions: string[] = [];
    const coordinator = makeCoordinator({ db, api, linear: { listSlackTicketDestinations: lookup, createSlackCodingTicket: create }, runAgent: async ({ tools, prompt }) => {
      actualPrompt = prompt;
      for (const name of ["create_ticket", "update_task"]) {
        const tool = tools.find((entry) => entry.name === name)!;
        descriptions.push(tool.description);
        const properties = (tool.parameters as { properties: Record<string, { description: string }> }).properties;
        for (const field of ["teamId", "projectId", "cycleId"]) descriptions.push(properties[field]!.description);
      }
      const result = await tools.find((tool) => tool.name === "list_ticket_destinations")!.execute("lookup", {}, undefined, undefined, {} as never);
      const returned = JSON.parse((result.content[0] as { text: string }).text) as typeof destinations;
      await tools.find((tool) => tool.name === "create_ticket")!.execute("create", {
        sourceTs: "100.1", requestIndex: 1, request: "Fix A later", title: "A", slackTitle: "fix A", description: "Fix A", delegateToBearMetal: false,
        teamId: returned.teams[0]!.id, projectId: returned.projects[0]!.id, cycleId: returned.cycles[0]!.id,
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(actualPrompt).toContain("Before supplying teamId, projectId, or cycleId to any task tool, call list_ticket_destinations");
      expect(actualPrompt).toContain("Never infer destination IDs from memory or unrelated entities");
      expect(descriptions).toHaveLength(8);
      for (const description of descriptions) expect(description).toContain("list_ticket_destinations");
      expect(lookup).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ teamId: "team-new", projectId: "project-new", cycleId: "cycle-new" }));
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|fix A>."]);
    } finally { await db.close(); }
  });

  it.each([false, true])("reacts only after successful unsubscription (failure=%s)", async (failure) => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> stop following" }]);
    if (failure) vi.spyOn(db, "unsubscribeSlackThread").mockRejectedValueOnce(new Error("Unsubscription failed"));
    let followingWhenReacted: boolean | undefined;
    vi.mocked(api.react).mockImplementation(async (thread) => { followingWhenReacted = await db.isSlackThreadFollowing(thread); });
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      await tools.find((tool) => tool.name === "unsubscribe_thread")!.execute("stop", { sourceTs: "100.1" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(api.react).toHaveBeenCalledTimes(failure ? 0 : 1);
      if (!failure) {
        expect(api.react).toHaveBeenCalledWith(key, "100.1", "thumbsup");
        expect(followingWhenReacted).toBe(false);
      }
      expect(replies).toEqual([]);
      expect(await db.isSlackThreadFollowing(key)).toBe(failure);
    } finally { await db.close(); }
  });

  it.each([false, true])("retries an unsubscribe reaction after restart while unfollowed (edit=%s)", async (edit) => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-reaction-recovery-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const sourceTs = edit ? "100.2" : "100.1";
    if (edit) await db.recordSlackEdit(key, sourceTs, "100.1", "U1", "<@UBOT> stop following");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> stop following" }]);
    vi.mocked(api.react).mockRejectedValueOnce(new Error("Slack HTTP 503"));
    const runAgent = vi.fn(async ({ tools }: Parameters<NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]>>[0]) => {
      await tools.find((tool) => tool.name === "unsubscribe_thread")!.execute("stop", { sourceTs }, undefined, undefined, {} as never);
    });
    try {
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(await db.isSlackThreadFollowing(key)).toBe(false);
      expect(await db.listSlackPendingThreads()).toEqual([key]);
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      const coordinator = makeCoordinator({ db, api, runAgent });
      await coordinator.poll();
      await coordinator.wake(key);
      expect(api.react).toHaveBeenCalledTimes(2);
      expect(api.react).toHaveBeenLastCalledWith(key, "100.1", "thumbsup");
      expect(runAgent).toHaveBeenCalledOnce();
      expect(await db.listSlackPendingThreads()).toEqual([]);
      await coordinator.wake(key);
      expect(api.react).toHaveBeenCalledTimes(2);
      expect(replies).toEqual([]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["message_not_found", "missing_scope", "service_unavailable"])("continues resumed DMs independently of reaction failure %s", async (error) => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-reaction-failure-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const messages = [{ ts: "100.1", user: "U1", text: "<@UBOT> stop following" }];
    const { api, replies } = makeApi(messages);
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error }));
    const writer = new SlackIntegration({ token: "token", channel: "C1", logger: createLogger({ name: "test", level: "silent" }), fetchImpl });
    vi.mocked(api.react).mockImplementation(async (_thread, ts, name) => writer.addReaction("C1", ts, name));
    const runAgent = vi.fn(async ({ tools }: Parameters<NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]>>[0]) => {
      if (runAgent.mock.calls.length === 1) {
        await tools.find((tool) => tool.name === "unsubscribe_thread")!.execute("stop", { sourceTs: "100.1" }, undefined, undefined, {} as never);
      } else {
        await tools.find((tool) => tool.name === "direct_answer")!.execute("answer", { sourceTs: "100.2", requestIndex: 1, answer: "Hello again" }, undefined, undefined, {} as never);
      }
    });
    const logger = createLogger({ name: "test", level: "silent" });
    const logError = vi.spyOn(logger, "error");
    let coordinator = makeCoordinator({ db, api, runAgent, logger });
    try {
      await coordinator.wake(key);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const state = error === "service_unavailable" ? "queued" : "failed";
      const expectedFailure = { sourceTs: "100.1", messageTs: "100.1", state, error: `SlackReactionError: Slack reactions.add failed: ${error}` };
      expect(await db.listSlackUnsubscribeReactions(key, true)).toEqual([expectedFailure]);
      expect(logError).toHaveBeenCalledWith(expect.objectContaining({ state, sourceTs: "100.1" }), "Slack unsubscribe reaction delivery failed");
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      expect(await db.listSlackUnsubscribeReactions(key, true)).toEqual([expectedFailure]);
      coordinator = makeCoordinator({ db, api, runAgent, logger });
      await db.followSlackThread(key, "100.2", true);
      await db.recordSlackMessage(key, "100.2");
      messages.push({ ts: "100.2", user: "U1", text: "Hello" });
      await coordinator.wake(key);
      expect(runAgent).toHaveBeenCalledTimes(2);
      expect(replies).toEqual(["Hello again"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(error === "service_unavailable" ? 2 : 1);
      expect(await db.listSlackUnsubscribeReactions(key, true)).toEqual([expectedFailure]);
      if (error === "service_unavailable") {
        vi.mocked(api.react).mockResolvedValueOnce();
        await coordinator.wake(key);
        expect(await db.listSlackUnsubscribeReactions(key, true)).toEqual([expect.objectContaining({ state: "posted", error: null })]);
      }
      expect(runAgent).toHaveBeenCalledTimes(2);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("reacts to the original Slack message when an edit unsubscribes", async () => {
    const db = await makeDb();
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "<@UBOT> stop following");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> stop following" }]);
    try {
      await makeCoordinator({ db, api, runAgent: async ({ tools }) => {
        await tools.find((tool) => tool.name === "unsubscribe_thread")!.execute("stop", { sourceTs: "100.2" }, undefined, undefined, {} as never);
      } }).wake(key);
      expect(api.react).toHaveBeenCalledWith(key, "100.1", "thumbsup");
      expect(await db.isSlackThreadFollowing(key)).toBe(false);
      expect(replies).toEqual([]);
    } finally { await db.close(); }
  });

  it("reports unrecovered task failures through direct_answer without claiming success", async () => {
    const db = await makeDb();
    const original = (await db.createSlackTask({ type: "coding", delegateToBearMetal: false, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Fix A later" })).task;
    await db.attachSlackTicket(original.id, "old-ticket", "https://linear.app/old");
    await db.beginSlackBatchAcknowledgment([original.id]);
    await db.markSlackTaskCoordinated(original.id, "old-reply");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> update the ticket to B" }]);
    const create = vi.fn(async () => { throw new Error("Linear unavailable"); });
    const delegate = vi.fn();
    let actualPrompt = "";
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent: async ({ tools, prompt }) => {
      actualPrompt = prompt;
      const update = tools.find((tool) => tool.name === "update_task")!;
      for (const call of ["first", "retry"]) await expect(update.execute(call, {
        id: original.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Fix B", teamId: "team", title: "B", description: "Fix B", slackTitle: "fix B",
      }, undefined, undefined, {} as never)).rejects.toThrow("Linear unavailable");
      await tools.find((tool) => tool.name === "direct_answer")!.execute("failure", { sourceTs: "100.2", requestIndex: 2, answer: "I couldn't create the replacement ticket. The original is unchanged." }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(actualPrompt).toContain("If task tool calls fail and subsequent attempts do not recover, use direct_answer to report the failure.");
      expect(actualPrompt).toContain("Never claim a ticket was created, work started, or delegation succeeded without a tool result confirming it.");
      expect(create).toHaveBeenCalledTimes(2);
      expect(delegate).not.toHaveBeenCalled();
      expect(replies).toEqual(["I couldn't create the replacement ticket. The original is unchanged."]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it.each([false, true])("creates a ticket with explicit delegation=%s", async (delegateToBearMetal) => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> open a ticket" }]);
    const create = vi.fn(async () => ({ id: "ticket-new", url: "https://linear.app/new", identifier: "DEN-1" }));
    const delegate = vi.fn();
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent: async ({ tools }) => {
      await tools.find((tool) => tool.name === "create_ticket")!.execute("create", {
        sourceTs: "100.1", requestIndex: 1, request: "Fix A", teamId: "team", title: "A", slackTitle: "fix A", description: "Fix A", delegateToBearMetal,
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: "linear-user-1" }));
      expect(delegate).toHaveBeenCalledTimes(delegateToBearMetal ? 1 : 0);
      expect(replies).toEqual([delegateToBearMetal ? "Created a ticket for <https://linear.app/new|fix A> and assigned it to Bear Metal." : "Created a ticket for <https://linear.app/new|fix A>."]);
      expect((await db.listSlackThreadTasks(key))[0]).toMatchObject({ delegateToBearMetal, state: "coordinated" });
      expect(await db.listTracked()).toEqual([]);
      expect(await db.acquireNext("worker-1")).toBeNull();
    } finally { await db.close(); }
  });

  it("requires an explicit delegation choice before creating a ticket", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> open a ticket for A" }]);
    const create = vi.fn(async () => ({ id: "ticket-new", url: "https://linear.app/new", identifier: "DEN-1" }));
    let actualPrompt = "";
    let delegationRequired = false;
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() }, runAgent: async ({ tools, prompt }) => {
      actualPrompt = prompt;
      const ticket = tools.find((tool) => tool.name === "create_ticket")!;
      delegationRequired = (ticket.parameters as { required?: string[] }).required?.includes("delegateToBearMetal") ?? false;
      await expect(ticket.execute("missing", { sourceTs: "100.1", requestIndex: 1, request: "Fix A", teamId: "team", title: "A", slackTitle: "fix A", description: "Fix A" }, undefined, undefined, {} as never)).rejects.toThrow("delegation choice");
      await tools.find((tool) => tool.name === "clarify_request")!.execute("clarify", { sourceTs: "100.1", requestIndex: 1, question: "Should I start working on it, or just create the ticket?" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(delegationRequired).toBe(true);
      expect(actualPrompt).toContain("delegateToBearMetal=false");
      expect(actualPrompt).toContain("delegateToBearMetal=true");
      expect(actualPrompt).toContain("clarify_request before creating the ticket");
      expect(create).not.toHaveBeenCalled();
      expect(replies).toEqual(["<@U1>, Should I start working on it, or just create the ticket?"]);
      expect(await db.listSlackThreadTasks(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("preserves creation-only intent after a rejected reply and restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-ticket-choice-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> open a ticket for later" }]);
    const create = vi.fn(async () => ({ id: "ticket-new", url: "https://linear.app/new", identifier: "DEN-1" }));
    const delegate = vi.fn();
    let rejected = false;
    vi.mocked(api.reply).mockImplementation(async (_key, text) => {
      if (!rejected) { rejected = true; throw new SlackThreadReplyRejectedError("channel_not_found"); }
      replies.push(text);
      return "reply-1";
    });
    let runs = 0;
    const runAgent: NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]> = async ({ tools }) => {
      await tools.find((tool) => tool.name === "create_ticket")!.execute("create", {
        sourceTs: "100.1", requestIndex: 1, request: "Fix A", teamId: "team", title: "A", slackTitle: "fix A", description: "Fix A", delegateToBearMetal: ++runs > 1,
      }, undefined, undefined, {} as never);
    };
    try {
      await makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent }).wake(key);
      expect(replies).toEqual([]);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      await makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent }).wake(key);
      expect(create).toHaveBeenCalledTimes(1);
      expect(delegate).not.toHaveBeenCalled();
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|fix A>."]);
      expect((await db.listSlackThreadTasks(key))[0]?.delegateToBearMetal).toBe(false);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each([undefined, false, true])("preserves creation-only replacements unless delegation explicitly changes (%s)", async (choice) => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "coding", delegateToBearMetal: false, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Fix A later" })).task;
    await db.attachSlackTicket(old.id, "old-ticket", "https://linear.app/old");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> change the ticket to B" }]);
    const delegate = vi.fn();
    const cancel = vi.fn();
    const coordinator = makeCoordinator({ db, api, linear: { cancelSlackCodingTicket: cancel, createSlackCodingTicket: vi.fn(async () => ({ id: "ticket-new", url: "https://linear.app/new", identifier: "DEN-1" })), delegateSlackCodingTicket: delegate }, runAgent: async ({ tools }) => {
      await tools.find((tool) => tool.name === "update_task")!.execute("update", {
        id: old.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Fix B", teamId: "team", title: "B", slackTitle: "fix B", description: "Fix B",
        ...(choice === undefined ? {} : { delegateToBearMetal: choice }),
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(cancel).toHaveBeenCalledWith("old-ticket");
      expect(delegate).toHaveBeenCalledTimes(choice === true ? 1 : 0);
      expect(replies).toEqual([choice === true ? "Created a ticket for <https://linear.app/new|fix B> and assigned it to Bear Metal." : "Created a ticket for <https://linear.app/new|fix B>."]);
      expect((await db.listSlackThreadTasks(key)).find((task) => task.ticketId === "ticket-new")?.delegateToBearMetal).toBe(choice === true);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("preserves the first reply when the same cancellation action repeats", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Research A", quote: "A" })).task;
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> cancel A" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const cancel = tools.find((tool) => tool.name === "cancel_task")!;
      for (const call of ["first", "repeated"]) await cancel.execute(call, { id: old.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Canceled A"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await db.getSlackTask(old.id))?.ackState).toBe("posted");
    } finally { await db.close(); }
  });

  it.each([false, true])("responds when an already-canceled task is requested again (DM=%s)", async (dm) => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const old = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: 1, request: "Find repositories", quote: "repositories" })).task;
    await db.cancelSlackTask(old.id);
    await db.beginSlackBatchAcknowledgment([old.id]);
    await db.markSlackTaskCoordinated(old.id, "previous-cancellation");
    await db.followSlackThread(key, "100.2", dm);
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: dm ? "Cancel that again" : "<@UBOT> cancel that again" }]);
    let requiresResponse = false;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      requiresResponse = JSON.parse(task.request!).messages[0].requiresResponse;
      await tools.find((tool) => tool.name === "cancel_task")!.execute("cancel", { id: old.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(requiresResponse).toBe(true);
      expect(replies).toEqual(["Already canceled repositories"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await db.getSlackTask(old.id))?.replyTs).toBe("previous-cancellation");
      expect((await db.getSlackTask(old.id))?.ackState).toBe("posted");
    } finally { await db.close(); }
  });

  it.each([false, true])("omits ignore instructions from response-required prompts (DM=%s)", async (dm) => {
    const db = await makeDb();
    if (dm) await db.followSlackThread(key, "100.1", true);
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: dm ? "Hello" : "<@UBOT> hello" }]);
    let actualPrompt = "";
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      actualPrompt = prompt;
      expect(tools.some((tool) => tool.name === "ignore_message")).toBe(false);
      await tools.find((tool) => tool.name === "direct_answer")!.execute("answer", { sourceTs: "100.1", requestIndex: 1, answer: "Hello" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(actualPrompt).toContain("direct_answer");
      expect(actualPrompt).not.toContain("ignore_message");
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("retries rejected cancellations in reversed tool order without changing their identities", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const tasks: Array<{ id: string }> = [];
    for (const quote of ["A", "B"]) tasks.push((await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", requestIndex: tasks.length + 1, request: `Research ${quote}`, quote })).task);
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> cancel A and B" }]);
    let attempts = 0;
    const writer = new SlackIntegration({ token: "token", channel: "C1", logger: createLogger({ name: "test", level: "silent" }), fetchImpl: async (_url, options) => {
      attempts++;
      if (attempts === 1) return new Response("Rate limited", { status: 429 });
      replies.push(JSON.parse(String(options?.body)).text);
      return Response.json({ ok: true, ts: "reply-1" });
    } });
    api.reply = async (thread, text) => writer.postThreadMessage(thread.channelId, thread.threadTs, text);
    let runs = 0;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const order = ++runs === 1 ? tasks : [...tasks].reverse();
      for (const task of order) await tools.find((tool) => tool.name === "cancel_task")!.execute(`cancel-${task.id}`, { id: task.id, sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual([]);
      expect(attempts).toBe(1);
      await coordinator.wake(key);
      expect(attempts).toBe(2);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.split("\n\n").sort()).toEqual(["Canceled A", "Canceled B"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await db.listSlackThreadTasks(key)).every((task) => task.ackState === "posted")).toBe(true);
    } finally { await db.close(); }
  });

  it("does not repeat a delivered clarification when a later answer is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-clarification-retry-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> implement it and say hello" }]);
    let rejected = false;
    const writer = new SlackIntegration({ token: "token", channel: "C1", logger: createLogger({ name: "test", level: "silent" }), fetchImpl: async (_url, options) => {
      const text = JSON.parse(String(options?.body)).text as string;
      if (text === "Answer" && !rejected) {
        rejected = true;
        return Response.json({ ok: false, error: "channel_not_found" });
      }
      replies.push(text);
      return Response.json({ ok: true, ts: `reply-${replies.length}` });
    } });
    api.reply = async (thread, text) => writer.postThreadMessage(thread.channelId, thread.threadTs, text);
    const runAgent: NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]> = async ({ tools }) => {
      await tools.find((tool) => tool.name === "clarify_request")!.execute("clarify", { sourceTs: "100.1", requestIndex: 1, question: "Which project?" }, undefined, undefined, {} as never);
      await tools.find((tool) => tool.name === "direct_answer")!.execute("answer", { sourceTs: "100.1", requestIndex: 2, answer: "Answer" }, undefined, undefined, {} as never);
    };
    try {
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(replies).toEqual(["<@U1>, Which project?"]);
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(replies).toEqual(["<@U1>, Which project?", "Answer"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["connection", "server", "malformed", "missing timestamp", "internal_error", "fatal_error", "unknown_error"])("does not retry an uncertain %s failure after Slack accepted an answer", async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-uncertain-reply-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> hello" }]);
    let attempts = 0;
    const writer = new SlackIntegration({ token: "token", channel: "C1", logger: createLogger({ name: "test", level: "silent" }), fetchImpl: async (_url, options) => {
      attempts++;
      replies.push(JSON.parse(String(options?.body)).text);
      if (attempts === 1) {
        if (failure === "connection") throw new TypeError("Connection closed after acceptance");
        if (failure === "server") return new Response("Server error", { status: 500 });
        if (failure === "malformed") return new Response("Invalid JSON");
        if (failure === "missing timestamp") return Response.json({ ok: true });
        return Response.json({ ok: false, error: failure });
      }
      return Response.json({ ok: true, ts: "reply-2" });
    } });
    api.reply = async (thread, text) => writer.postThreadMessage(thread.channelId, thread.threadTs, text);
    const runAgent: NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]> = async ({ tools }) => {
      await tools.find((tool) => tool.name === "direct_answer")!.execute("answer", { sourceTs: "100.1", requestIndex: 1, answer: "Answer" }, undefined, undefined, {} as never);
    };
    try {
      await makeCoordinator({ db, api, runAgent }).wake(key);
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      await db.recoverSlackResearchTasks();
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(replies).toEqual(["Answer"]);
      expect(attempts).toBe(1);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not repeat a delivered task and clarification group when a later answer is rejected", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> change A, change something else, and say hello" }]);
    let rejected = false;
    vi.mocked(api.reply).mockImplementation(async (_key, text) => {
      if (text === "Answer" && !rejected) { rejected = true; throw new SlackThreadReplyRejectedError("Slack rejected answer"); }
      replies.push(text);
      return `reply-${replies.length}`;
    });
    const create = vi.fn(async () => ({ id: "A", url: "https://linear.app/ticket/A", identifier: "A" }));
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() }, runAgent: async ({ tools }) => {
      await tools.find((tool) => tool.name === "create_ticket")!.execute("ticket", { sourceTs: "100.1", requestIndex: 1, request: "Change A", delegateToBearMetal: true, teamId: "team", title: "A", slackTitle: "change A", description: "Change A" }, undefined, undefined, {} as never);
      await tools.find((tool) => tool.name === "clarify_request")!.execute("clarify", { sourceTs: "100.1", requestIndex: 2, question: rejected ? "Regenerated question" : "Which project?" }, undefined, undefined, {} as never);
      await tools.find((tool) => tool.name === "direct_answer")!.execute("answer", { sourceTs: "100.1", requestIndex: 3, answer: "Answer" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A> and assigned it to Bear Metal.\n\n<@U1>, Which project?", "Answer"]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("posts a cancellation after an earlier task acknowledgment was delivered", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> research A" }]);
    let researchId = "";
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (task.request && JSON.parse(task.request).resultTaskId) {
        await tools.find((tool) => tool.name === "get_thread_task")!.execute("read", { id: researchId }, undefined, undefined, {} as never);
        await tools.find((tool) => tool.name === "cancel_task")!.execute("cancel", { id: researchId }, undefined, undefined, {} as never);
      } else {
        await tools.find((tool) => tool.name === "start_research")!.execute("research", { sourceTs: "100.1", requestIndex: 1, request: "Research A", quote: "A" }, undefined, undefined, {} as never);
        researchId = (await db.listSlackThreadTasks(key))[0]!.id;
      }
    } });
    try {
      await coordinator.wake(key);
      await db.claimSlackResearchTask();
      await db.completeSlackResearchTask(researchId, "Old answer");
      await coordinator.wake(key);
      expect(replies).toEqual(["Looking into A.", "Canceled A"]);
    } finally { await db.close(); }
  });

  it("silently ignores messages addressed to others but rejects ignoring explicit mentions", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackMessage(key, "100.2");
    await db.followSlackThread(key, "100.3");
    await db.recordSlackMessage(key, "100.3");
    const { api, replies } = makeApi([
      { ts: "100.2", user: "U1", text: "<@U2> please check this" },
      { ts: "100.3", user: "U1", text: "<@UBOT> hello" },
    ]);
    let ignoreAvailable = false;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      expect(prompt).toContain("ignore_message");
      const ignore = tools.find((tool) => tool.name === "ignore_message");
      ignoreAvailable = ignore !== undefined;
      if (!ignore) throw new Error("ignore_message missing");
      await ignore.execute("ignore", { sourceTs: "100.2", reason: "Addressed to U2" }, undefined, undefined, {} as never);
      await expect(ignore.execute("ignore-mention", { sourceTs: "100.3", reason: "Greeting" }, undefined, undefined, {} as never)).rejects.toThrow("response or action");
      const answer = tools.find((tool) => tool.name === "direct_answer")!;
      await answer.execute("answer", { sourceTs: "100.3", requestIndex: 1, answer: "Hello" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(ignoreAvailable, "ordinary messages need a silent-ignore decision").toBe(true);
      expect(replies).toEqual(["Hello"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("does not resend successful direct answers after a later reply fails and the manager restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-direct-answer-retry-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([
      { ts: "100.1", user: "U1", text: "<@UBOT> hello, how are you?" },
    ]);
    let failed = false;
    vi.mocked(api.reply).mockImplementation(async (_key, text) => {
      if (text === "I am fine" && !failed) { failed = true; throw new SlackThreadReplyRejectedError("Slack rejected reply"); }
      replies.push(text);
      return `reply-${replies.length}`;
    });
    const runAgent = async ({ tools }: Parameters<NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]>>[0]) => {
      const answer = tools.find((tool) => tool.name === "direct_answer")!;
      await answer.execute("first", { sourceTs: "100.1", requestIndex: 1, answer: failed ? "Regenerated greeting" : "Hello" }, undefined, undefined, {} as never);
      await answer.execute("second", { sourceTs: "100.1", requestIndex: 2, answer: failed ? "Regenerated answer" : "I am fine" }, undefined, undefined, {} as never);
    };
    try {
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(replies).toEqual(["Hello"]);
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      await makeCoordinator({ db, api, runAgent }).wake(key);
      expect(replies).toEqual(["Hello", "I am fine"]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("requires a response for every DM even without mention text", async () => {
    const db = await makeDb();
    await db.followSlackThread(key, "100.1", true);
    await db.recordSlackMessage(key, "100.1");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([
      { ts: "100.1", user: "U1", text: "hello" },
      { ts: "100.2", user: "U1", text: "how are you?" },
    ]);
    const required: boolean[] = [];
    let ignoreAvailable = true;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      required.push(...JSON.parse(task.request).messages.map((message: { requiresResponse: boolean }) => message.requiresResponse));
      ignoreAvailable = tools.some((tool) => tool.name === "ignore_message");
      const answer = tools.find((tool) => tool.name === "direct_answer")!;
      await answer.execute("first", { sourceTs: "100.1", requestIndex: 1, answer: "Hello" }, undefined, undefined, {} as never);
      await answer.execute("second", { sourceTs: "100.2", requestIndex: 1, answer: "I am fine" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(required).toEqual([true, true]);
      expect(ignoreAvailable).toBe(false);
      expect(replies).toEqual(["Hello", "I am fine"]);
    } finally { await db.close(); }
  });

  it("answers a mention verbatim without creating a task or offering ignore", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "<@UBOT> how are you?" }]);
    const answer = "I'm all good, my friend\nFine, and how are you doing, amigo?";
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      expect(tools.some((tool) => tool.name === "ignore_message")).toBe(false);
      expect(prompt).toContain("direct_answer");
      const tool = tools.find((tool) => tool.name === "direct_answer");
      if (!tool) throw new Error("direct_answer missing");
      await tool.execute("answer", { sourceTs: "100.1", requestIndex: 1, answer }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual([answer]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackThreadTasks(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("unsubscribes and suppresses late research even after a later mention", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    const research = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "100.1", sourceUserId: "U1", requestIndex: 1, request: "Find A", quote: "A" })).task;
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "Stop bothering this thread" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const tool = tools.find((tool) => tool.name === "unsubscribe_thread");
      if (!tool) throw new Error("unsubscribe_thread missing");
      await tool.execute("stop", { sourceTs: "100.2" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(await db.hasSlackThread(key)).toBe(false);
      expect((await db.claimSlackResearchTask())?.id).toBe(research.id);
      await db.completeSlackResearchTask(research.id, "Late answer");
      await coordinator.wake(key);
      expect(replies).toEqual([]);
      expect(await db.listSlackPendingThreads()).toEqual([]);
      await db.followSlackThread(key, "100.4");
      await db.recordSlackMessage(key, "100.4");
      await db.markSlackMessagesProcessed(key, ["100.4"]);
      expect(await db.hasSlackThread(key)).toBe(true);
      await coordinator.wake(key);
      expect(replies).toEqual([]);
      expect(await db.listSlackPendingThreads()).toEqual([]);
    } finally { await db.close(); }
  });

  it("handles a newer mention after unsubscribe in the same pending batch", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackMessage(key, "100.2");
    await db.recordSlackMessage(key, "100.25");
    await db.followSlackThread(key, "100.3");
    await db.recordSlackMessage(key, "100.3");
    await db.followSlackThread(key, "100.4");
    await db.recordSlackMessage(key, "100.4");
    const { api, replies } = makeApi([
      { ts: "100.2", user: "U1", text: "Stop bothering this thread" },
      { ts: "100.25", user: "U2", text: "This is addressed to somebody else" },
      { ts: "100.3", user: "U1", text: "<@UBOT> hello again" },
      { ts: "100.4", user: "U1", text: "<@UBOT> and how are you?" },
    ]);
    let runs = 0;
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      runs++;
      if (!task.request) throw new Error("Coordinator request missing");
      batches.push(JSON.parse(task.request).messages.map((message: { ts: string }) => message.ts));
      const name = runs === 1 ? "unsubscribe_thread" : "direct_answer";
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`${name} missing`);
      await tool.execute("call", runs === 1 ? { sourceTs: "100.2" }
        : { sourceTs: "100.3", requestIndex: 1, answer: "Hello again, amigo!" }, undefined, undefined, {} as never);
      if (runs !== 1) await tool.execute("call-2", { sourceTs: "100.4", requestIndex: 1, answer: "I'm all good, my friend" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(runs).toBe(2);
      expect(batches[1]).toEqual(["100.3", "100.4"]);
      expect(replies).toEqual(["Hello again, amigo!", "I'm all good, my friend"]);
      expect(await db.hasSlackThread(key)).toBe(true);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });
  it("processes a pending edit when Slack returns the thread parent before the edited reply", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Edited request");
    await db.recordSlackMessage(key, "100.3");
    const parent = { ts: "100.0", user: "U0", text: "Thread parent" };
    const call = vi.fn(async (_method: string, params: { oldest: string; latest?: string }) => {
      if (params.oldest === "100.3" && params.latest === undefined) return { ok: true, has_more: false, messages: [parent, { ts: "100.3", user: "U1", text: "New request" }] };
      if (params.oldest === "100.1" && params.latest === "100.1") return { ok: true, has_more: false, messages: [parent, { ts: "100.1", user: "U1", text: "Edited request" }] };
      throw new Error(`Unexpected Slack read ${params.oldest}/${params.latest}`);
    });
    const api = new SlackThreadApi({ call } as unknown as SlackReadClient, {} as SlackIntegration);
    vi.spyOn(api, "reply").mockResolvedValue("reply-1");
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const messages = (JSON.parse(task.request) as { messages: Array<{ ts: string }> }).messages;
      batches.push(messages.map((message) => message.ts));
      const answer = tools.find((tool) => tool.name === "direct_answer");
      if (!answer) throw new Error("direct_answer missing");
      for (const message of messages) await answer.execute(`answer-${message.ts}`, { sourceTs: message.ts, requestIndex: 1, answer: "Acknowledged" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(batches).toEqual([["100.2", "100.3"]]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackPendingEdits(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("abandons a pending edit when Slack returns only the thread parent for its deleted reply", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Edited, then deleted");
    const call = vi.fn(async (_method: string, params: { oldest: string; latest?: string }) => {
      if (params.oldest === "100.1" && params.latest === "100.1") return { ok: true, has_more: false, messages: [{ ts: "100.0", user: "U0", text: "Thread parent" }] };
      throw new Error(`Unexpected Slack read ${params.oldest}/${params.latest}`);
    });
    const api = new SlackThreadApi({ call } as unknown as SlackReadClient, {} as SlackIntegration);
    const runAgent = vi.fn(async () => { throw new Error("Coordinator must not run for a deleted edit"); });
    const coordinator = makeCoordinator({ db, api, runAgent });
    try {
      await coordinator.wake(key);
      expect(runAgent).not.toHaveBeenCalled();
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(await db.listSlackPendingEdits(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });
  it("abandons a pending edit whose original message was deleted and continues with later replies", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    await db.markSlackMessagesProcessed(key, ["100.1"]);
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Edited, then deleted");
    await db.recordSlackMessage(key, "100.3");
    const api = {
      readThread: vi.fn(async (_key: SlackThreadKey, oldest: string, latest?: string) => {
        if (oldest === "100.3" && latest === undefined) return [{ ts: "100.3", user: "U1", text: "New request" }];
        throw new Error(`Unexpected Slack read ${oldest}/${latest}`);
      }),
      readThreadMessage: vi.fn(async (_key: SlackThreadKey, ts: string) => {
        if (ts === "100.1") return null;
        throw new Error(`Unexpected Slack message read ${ts}`);
      }),
      reply: vi.fn().mockResolvedValue("reply-1"),
    } as unknown as SlackThreadApi;
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools }) => {
      const answer = tools.find((tool) => tool.name === "direct_answer");
      if (!answer) throw new Error("direct_answer missing");
      await answer.execute("ignore", { sourceTs: "100.3", requestIndex: 1, answer: "Acknowledged" }, undefined, undefined, {} as never);
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
        if (oldest === "100.8" && latest === undefined) return [
          { ts: "100.8", user: "U1", text: "Pending" },
          { ts: "100.9", user: "U1", text: "Gap reply" },
        ];
        throw new Error(`Unexpected Slack read ${oldest}/${latest}`);
      }),
      readThreadMessage: vi.fn(async (_key: SlackThreadKey, ts: string) => {
        if (ts === "100.1") return { ts: "100.1", user: "U1", text: "Edited request" };
        throw new Error(`Unexpected Slack message read ${ts}`);
      }),
      reply: vi.fn().mockResolvedValue("reply-1"),
    } as unknown as SlackThreadApi;
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const messages = (JSON.parse(task.request) as { messages: Array<{ ts: string }> }).messages;
      batches.push(messages.map((message) => message.ts));
      const answer = tools.find((tool) => tool.name === "direct_answer");
      if (!answer) throw new Error("direct_answer missing");
      for (const message of messages) await answer.execute(`ignore-${message.ts}`, { sourceTs: message.ts, requestIndex: 1, answer: "Acknowledged" }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(vi.mocked(api.readThread)).toHaveBeenCalledExactlyOnceWith(key, "100.8");
      expect(vi.mocked(api.readThreadMessage)).toHaveBeenCalledExactlyOnceWith(key, "100.1");
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
      expect(vi.mocked(api.readThreadMessage)).toHaveBeenCalledExactlyOnceWith(key, "100.1");
      expect(vi.mocked(api.readThread)).not.toHaveBeenCalled();
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
    }), reply: vi.fn().mockResolvedValue("reply-1") } as unknown as SlackThreadApi;
    const batches: string[][] = [];
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, task }) => {
      if (!task.request) throw new Error("Coordinator request missing");
      const messages = (JSON.parse(task.request) as { messages: Array<{ ts: string }> }).messages;
      batches.push(messages.map((message) => message.ts));
      const answer = tools.find((tool) => tool.name === "direct_answer");
      if (!answer) throw new Error("direct_answer missing");
      for (const message of messages) await answer.execute(`ignore-${message.ts}`, { sourceTs: message.ts, requestIndex: 1, answer: "Acknowledged" }, undefined, undefined, {} as never);
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

  it("responds to a conversational message without creating a task", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Thanks" }]);
    const coordinator = makeCoordinator({ db, api, runAgent: async ({ tools, prompt }) => {
      expect(prompt).toContain("Those messages must receive a response or action");
      const answer = tools.find((tool) => tool.name === "direct_answer");
      if (!answer) throw new Error("direct_answer missing");
      expect(answer.description).toContain("verbatim");
      await answer.execute("ignore", { sourceTs: "100.1", requestIndex: 1, answer: "You're welcome" }, undefined, undefined, {} as never);
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
      expect(JSON.stringify(clarify.parameters)).not.toContain('"quote"');
      await clarify.execute("clarify", {
        sourceTs: "100.1", requestIndex: 1,
        question: "What code change, if any, do you mean by this?",
      }, undefined, undefined, {} as never);
      expect(replies).toEqual([]);
    } });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["<@U1>, What code change, if any, do you mean by this?"]);
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
        sourceTs: "100.1", requestIndex: 1,
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
    vi.mocked(api.reply).mockRejectedValueOnce(new SlackThreadReplyRejectedError("Slack rate limit rejected reply"));
    const create = vi.fn(async () => ({ id: "A", url: "https://linear.app/ticket/A", identifier: "A" }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn() },
      runAgent: async ({ tools }) => {
        const ticket = tools.find((tool) => tool.name === "create_ticket");
        const research = tools.find((tool) => tool.name === "start_research");
        if (!ticket || !research) throw new Error("Task tools missing");
        await ticket.execute("a", { sourceTs: "100.1", requestIndex: 1, request: "Change A", delegateToBearMetal: true, teamId: "team", title: "A", slackTitle: "change A", description: "Change A" }, undefined, undefined, {} as never);
        await research.execute("b", { sourceTs: "100.1", requestIndex: 2, request: "Explain B", quote: "why B is slow" }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.1"]);
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A> and assigned it to Bear Metal.\n\nLooking into why B is slow."]);
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
            delegateToBearMetal: true, teamId: "team", title, slackTitle: `change ${title}`, description: `Change ${title}`,
          }, undefined, undefined, {} as never);
        }
        await clarify.execute("clarify", {
          sourceTs: "100.1", requestIndex: 3,
          question: "What change do you want Bear Metal to make?",
        }, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(2);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A> and assigned it to Bear Metal.\n\nCreated a ticket for <https://linear.app/ticket/B|change B> and assigned it to Bear Metal.\n\n<@U1>, What change do you want Bear Metal to make?"]);
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
            delegateToBearMetal: true, teamId: "team", projectId: "project", title, slackTitle: title, description: title,
          }, undefined, undefined, {} as never);
        }
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project", assigneeId: "linear-user-1" }));
      expect(delegate).toHaveBeenCalledTimes(2);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|A> and assigned it to Bear Metal.\n\nCreated a ticket for <https://linear.app/ticket/B|B> and assigned it to Bear Metal."]);
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
        await tool.execute("ticket", { sourceTs: "100.1", requestIndex: 1, request: "Create a ticket", delegateToBearMetal: true, teamId: "team", title: "Ticket", slackTitle: "create a ticket", description: "Task" }, undefined, undefined, {} as never);
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

  it.each([false, true])("preserves the original on replacement failure and retries after restart (replacement ID=%s)", async (retryReplacement) => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-replacement-recovery-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    let db = new SqlDbClient(url, 5);
    await db.initSchema();
    await db.followSlackThread(key, "100.1");
    const original = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Implement A" })).task;
    await db.attachSlackTicket(original.id, "old-ticket", "https://linear.app/old");
    await db.beginSlackBatchAcknowledgment([original.id]);
    await db.markSlackTaskCoordinated(original.id, "original-reply");
    const before = await db.getSlackTask(original.id);
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> implement B instead" }]);
    const create = vi.fn().mockRejectedValueOnce(new Error("Replacement creation failed")).mockResolvedValue({ id: "new-ticket", url: "https://linear.app/new", identifier: "DEN-2" });
    const cancel = vi.fn();
    const delegate = vi.fn();
    let retryId = original.id;
    const runAgent: NonNullable<ConstructorParameters<typeof SlackCoordinator>[0]["runAgent"]> = async ({ tools }) => {
      await tools.find((tool) => tool.name === "update_task")!.execute("update", {
        id: retryId, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Implement B", teamId: "team", title: "B", slackTitle: "implement B", description: "Implement B",
      }, undefined, undefined, {} as never);
    };
    try {
      await makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, cancelSlackCodingTicket: cancel, delegateSlackCodingTicket: delegate }, runAgent }).wake(key);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await db.getSlackTask(original.id)).toEqual(before);
      expect(cancel).not.toHaveBeenCalled();
      expect(delegate).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.2"]);
      const failed = (await db.listSlackThreadTasks(key)).find((task) => task.id !== original.id)!;
      expect(failed.state).toBe("failed");
      expect(failed.replacesTaskId).toBe(original.id);
      if (retryReplacement) retryId = failed.id;
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      await makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, cancelSlackCodingTicket: cancel, delegateSlackCodingTicket: delegate }, runAgent }).wake(key);
      expect(create).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledWith("old-ticket");
      expect(delegate).toHaveBeenCalledWith("new-ticket");
      expect((await db.getSlackTask(original.id))).toMatchObject({ state: "canceled", supersededBy: failed.id });
      expect((await db.getSlackTask(failed.id))).toMatchObject({ state: "coordinated", ticketId: "new-ticket" });
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|implement B> and assigned it to Bear Metal."]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["cancellation", "delegation"])("resumes an attached replacement after %s fails without creating another ticket", async (failure) => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Implement A" })).task;
    await db.attachSlackTicket(old.id, "old-ticket", "https://linear.app/old");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "<@UBOT> implement B instead" }]);
    const create = vi.fn(async () => ({ id: "new-ticket", url: "https://linear.app/new", identifier: "DEN-2" }));
    let failed = false;
    const cancel = vi.fn(async () => { if (failure === "cancellation" && !failed) { failed = true; throw new Error("Cancellation rejected"); } });
    const delegate = vi.fn(async () => { if (failure === "delegation" && !failed) { failed = true; throw new Error("Delegation rejected"); } });
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create, cancelSlackCodingTicket: cancel, delegateSlackCodingTicket: delegate }, runAgent: async ({ tools }) => {
      await tools.find((tool) => tool.name === "update_task")!.execute("update", {
        id: old.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Implement B", teamId: "team", title: "B", slackTitle: "implement B", description: "Implement B",
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledOnce();
      const replacement = (await db.listSlackThreadTasks(key)).find((task) => task.id !== old.id)!;
      expect(replacement).toMatchObject({ state: "failed", ticketId: "new-ticket" });
      expect(replies).toEqual([]);
      expect(await db.listSlackPendingMessages(key)).toEqual(["100.2"]);
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledOnce();
      expect((await db.getSlackTask(replacement.id))).toMatchObject({ state: "coordinated", ticketId: "new-ticket" });
      expect((await db.getSlackTask(old.id))).toMatchObject({ state: "canceled", supersededBy: replacement.id });
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|implement B> and assigned it to Bear Metal."]);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally { await db.close(); }
  });

  it("creates and attaches a replacement before canceling the old ticket", async () => {
    const db = await makeDb();
    const old = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Implement A" })).task;
    await db.attachSlackTicket(old.id, "old-ticket", "https://linear.app/old");
    await db.recordSlackMessage(key, "100.2");
    const { api, replies } = makeApi([{ ts: "100.2", user: "U1", text: "Implement B instead" }]);
    const order: string[] = [];
    const cancel = vi.fn(async (id: string) => {
      const replacement = (await db.listSlackThreadTasks(key)).find((task) => task.ticketId === "new-ticket");
      expect(replacement?.state).toBe("awaiting_coordination");
      order.push(`cancel ${id}`);
    });
    const create = vi.fn(async () => { order.push("create new"); return { id: "new-ticket", url: "https://linear.app/new", identifier: "DEN-2" }; });
    const delegate = vi.fn(async () => { order.push("delegate new"); });
    const coordinator = makeCoordinator({ db, api, linear: { cancelSlackCodingTicket: cancel, createSlackCodingTicket: create, delegateSlackCodingTicket: delegate }, runAgent: async ({ tools }) => {
      const update = tools.find((tool) => tool.name === "update_task");
      if (!update) throw new Error("update_task missing");
      await update.execute("update", {
        id: old.id, sourceTs: "100.2", requestIndex: 1, type: "coding", request: "Implement B",
        delegateToBearMetal: true, teamId: "team", title: "B", slackTitle: "implement B", description: "Implement B",
      }, undefined, undefined, {} as never);
    } });
    try {
      await coordinator.wake(key);
      expect(order).toEqual(["create new", "cancel old-ticket", "delegate new"]);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/new|implement B> and assigned it to Bear Metal."]);
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
        await ticket.execute("a", { sourceTs: "100.1", requestIndex: 1, request: "Change A", delegateToBearMetal: true, teamId: "team", title: "A", slackTitle: "change A", description: "Change A" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
        await research.execute("b", { sourceTs: "100.1", requestIndex: 2, request: "Explain B", quote: "why B is slow" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
        await ticket.execute("c", { sourceTs: "100.1", requestIndex: 3, request: "Change C", delegateToBearMetal: true, teamId: "team", title: "C", slackTitle: "change C", description: "Change C" }, undefined, undefined, {} as never);
        expect(replies).toEqual([]);
      },
    });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/A|change A> and assigned it to Bear Metal.\n\nLooking into why B is slow.\n\nCreated a ticket for <https://linear.app/ticket/C|change C> and assigned it to Bear Metal."]);
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
      expect(replies).toEqual(["Looking into Find A.", 'Replying to <@U1>\'s "Find A"\n\nAnswer A']);
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
    const task = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "100.1", requestIndex: 1, request: "Create ticket" })).task;
    await db.attachSlackTicket(task.id, "linear-1", "https://linear.app/ticket/1");
    const { api, replies } = makeApi([]);
    const create = vi.fn();
    const runAgent = vi.fn(async () => {});
    const coordinator = makeCoordinator({ db, api, linear: { createSlackCodingTicket: create }, runAgent });
    try {
      await coordinator.wake(key);
      expect(replies).toEqual(["Created a ticket for <https://linear.app/ticket/1|Create ticket> and assigned it to Bear Metal."]);
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
        const args = { sourceTs: "100.1", requestIndex: 1, request: "Create ticket", delegateToBearMetal: true, teamId: "team", projectId: "project", title: "Ticket", slackTitle: "create ticket", description: "Task" };
        await expect(tool.execute("first", args, undefined, undefined, {} as never)).rejects.toThrow("Linear response lost");
        await tool.execute("replay", args, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([]);
      expect((await db.listSlackThreadTasks(key))[0]?.state).toBe("failed");
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("does not acknowledge a failed ticket after delegation fails", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api, replies } = makeApi([{ ts: "100.1", user: "U1", text: "Create ticket" }]);
    const create = vi.fn(async () => ({ id: "linear-1", url: "https://linear.app/ticket/1", identifier: "DEN-1" }));
    const coordinator = makeCoordinator({
      db, api, linear: { createSlackCodingTicket: create, delegateSlackCodingTicket: vi.fn(async () => { throw new Error("Delegation failed"); }) },
      runAgent: async ({ tools }) => {
        const ticket = tools.find((tool) => tool.name === "create_ticket");
        if (!ticket) throw new Error("create_ticket missing");
        const args = { sourceTs: "100.1", requestIndex: 1, request: "Create ticket", delegateToBearMetal: true, teamId: "team", title: "Ticket", slackTitle: "create ticket", description: "Task" };
        await expect(ticket.execute("first", args, undefined, undefined, {} as never)).rejects.toThrow("Delegation failed");
        await ticket.execute("replay", args, undefined, undefined, {} as never);
      },
    });
    try {
      await coordinator.wake(key);
      expect(create).toHaveBeenCalledTimes(1);
      expect(replies).toEqual([]);
      expect((await db.listSlackThreadTasks(key))[0]?.state).toBe("failed");
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("does not start a coordinator run after the entire fetched batch is processed concurrently", async () => {
    const db = await makeDb();
    await db.recordSlackMessage(key, "100.1");
    const { api } = makeApi([{ ts: "100.1", user: "U1", text: "Already processed" }]);
    const listPending = db.listSlackPendingMessages.bind(db);
    let reads = 0;
    vi.spyOn(db, "listSlackPendingMessages").mockImplementation(async (thread) => {
      reads += 1;
      if (reads === 2) {
        await db.markSlackMessagesProcessed(key, ["100.1"]);
        return [];
      }
      return listPending(thread);
    });
    const runAgent = vi.fn(async () => {});
    const coordinator = makeCoordinator({ db, api, runAgent });
    try {
      await coordinator.wake(key);
      expect(runAgent).not.toHaveBeenCalled();
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
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
