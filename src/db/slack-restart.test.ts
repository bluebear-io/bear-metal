import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "./client.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "1.0" };

describe("Slack restart recovery", () => {
  it("migrates legacy coding delegation and preserves explicit creation-only choices on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-delegation-migration-"));
    const path = join(dir, "db.sqlite");
    const url = `sqlite:${path}`;
    let db = new SqlDbClient(url, 5);
    try {
      await db.initSchema();
      await db.followSlackThread(key, "1.1");
      const legacyTask = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "1.1", requestIndex: 1, request: "Fix A" })).task;
      await db.close();
      const legacy = new DatabaseSync(path);
      try { legacy.exec("ALTER TABLE tasks DROP COLUMN slack_delegate_to_bear_metal"); } finally { legacy.close(); }
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      expect((await db.getSlackTask(legacyTask.id))?.delegateToBearMetal).toBe(true);
      const later = (await db.createSlackTask({ type: "coding", delegateToBearMetal: false, thread: key, sourceTs: "1.2", requestIndex: 1, request: "Fix B later" })).task;
      await db.close();
      db = new SqlDbClient(url, 5);
      await db.initSchema();
      expect((await db.getSlackTask(legacyTask.id))?.delegateToBearMetal).toBe(true);
      expect((await db.getSlackTask(later.id))?.delegateToBearMetal).toBe(false);
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("migrates cancellation receipts to stable task identities without resetting delivery state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-cancellation-identity-"));
    const path = join(dir, "db.sqlite");
    const url = `sqlite:${path}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      await first.followSlackThread(key, "1.1");
      await first.close();
      const legacy = new DatabaseSync(path);
      try {
        legacy.exec(`CREATE TABLE slack_coordination_replies (
          workspace_id TEXT, channel_id TEXT, thread_ts TEXT, source_ts TEXT, request_index INTEGER,
          reply_text TEXT, reply_kind TEXT, task_id TEXT, direct INTEGER, group_key TEXT,
          state TEXT, reply_ts TEXT, error TEXT, created_at TEXT, updated_at TEXT,
          PRIMARY KEY (workspace_id, channel_id, thread_ts, source_ts, request_index, reply_kind))`);
        const insert = legacy.prepare(`INSERT INTO slack_coordination_replies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const [id, index, state] of [["A", 1_000_001, "queued"], ["B", 1_000_002, "posting"]] as const) {
          insert.run(key.workspaceId, key.channelId, key.threadTs, "1.2", index, `Canceled ${id}`, "task_cancel", id, 0, "legacy-group", state, null, null, "2026-10-06", "2026-10-06");
        }
      } finally { legacy.close(); }
      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        const a = await second.queueSlackCoordinationReply(key, { sourceTs: "1.2", requestIndex: 1_000_000, taskId: "A", kind: "task_cancel", text: "Canceled A" });
        const b = await second.queueSlackCoordinationReply(key, { sourceTs: "1.2", requestIndex: 1_000_000, taskId: "B", kind: "task_cancel", text: "Canceled B" });
        expect(a).toMatchObject({ state: "queued", requestIndex: 1_000_001 });
        expect(b).toMatchObject({ state: "posting", requestIndex: 1_000_002 });
        await expect(second.beginSlackReplyGroup(key, [b])).rejects.toThrow("Cannot begin Slack reply group");
        const group = await second.beginSlackReplyGroup(key, [a]);
        await second.finishSlackReplyGroup(key, group, "posted", "reply-1", null);
        expect((await second.queueSlackCoordinationReply(key, a)).state).toBe("posted");
        expect((await second.queueSlackCoordinationReply(key, b)).state).toBe("posting");
      } finally { await second.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps unsubscribe durable, rejects replayed mentions, and resumes only new work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-unsubscribe-restart-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      await first.followSlackThread(key, "1.1");
      await first.recordSlackMessage(key, "1.1");
      const task = (await first.createSlackTask({ type: "research", thread: key, sourceTs: "1.1", requestIndex: 1, request: "Question", quote: "Question" })).task;
      await first.claimSlackResearchTask();
      await first.unsubscribeSlackThread(key, "1.2");
      await first.close();
      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        await second.recoverSlackResearchTasks();
        await second.claimSlackResearchTask();
        await second.completeSlackResearchTask(task.id, "Late answer");
        expect(await second.hasSlackThread(key)).toBe(false);
        expect(await second.recordSlackMessage(key, "1.3")).toBe(false);
        expect(await second.listSlackPendingThreads()).toEqual([]);
        await second.followSlackThread(key, "1.1");
        expect(await second.hasSlackThread(key)).toBe(false);
        await second.followSlackThread(key, "1.4");
        await second.recordSlackMessage(key, "1.4");
        expect(await second.hasSlackThread(key)).toBe(true);
        expect(await second.listSlackPendingMessages(key)).toEqual(["1.4"]);
        expect(await second.isSlackThreadFollowing(key, task.sourceTs)).toBe(false);
        expect(await second.isSlackThreadFollowing(key, "1.4")).toBe(true);
        await second.markSlackMessagesProcessed(key, ["1.4"]);
        expect(await second.listSlackPendingThreads()).toEqual([]);
      } finally { await second.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects an edit row missing its required user or text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-malformed-edit-"));
    const path = join(dir, "db.sqlite");
    const db = new SqlDbClient(`sqlite:${path}`, 5);
    try {
      await db.initSchema();
      await db.followSlackThread(key, "1.0");
      const raw = new DatabaseSync(path);
      try {
        raw.prepare(`INSERT INTO slack_processed_messages
          (workspace_id, channel_id, message_ts, thread_ts, original_message_ts, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(key.workspaceId, key.channelId, "1.2", key.threadTs, "1.1", new Date().toISOString());
      } finally {
        raw.close();
      }
      await expect(db.listSlackPendingEdits(key)).rejects.toThrow("Slack edit 1.2 is missing user or text");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not retain replies from unfollowed threads or before the first mention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-early-reply-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      expect(await first.recordSlackMessage(key, "1.05")).toBe(false);
      expect(await first.listSlackPendingThreads()).toEqual([]);
      await first.close();
      const legacy = new DatabaseSync(join(dir, "db.sqlite"));
      legacy.prepare(`INSERT OR IGNORE INTO slack_processed_messages
        (workspace_id, channel_id, message_ts, thread_ts, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(key.workspaceId, key.channelId, "1.05", key.threadTs, new Date().toISOString());
      legacy.close();

      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        await second.followSlackThread(key, "1.1");
        expect(await second.listSlackPendingThreads()).toEqual([]);
        expect(await second.recordSlackMessage(key, "1.05")).toBe(false);
        await second.recordSlackMessage(key, "1.1");
        expect(await second.listSlackPendingThreads()).toEqual([key]);
        expect(await second.listSlackPendingMessages(key)).toEqual(["1.1"]);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not repeat uncertain research or cancellation acknowledgments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-ack-restart-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      const research = (await first.createSlackTask({ type: "research", thread: key, sourceTs: "1.1", requestIndex: 1, request: "Question", quote: "Question" })).task;
      const canceled = (await first.createSlackTask({ type: "research", thread: key, sourceTs: "1.2", requestIndex: 1, request: "Old", quote: "Old" })).task;
      await first.cancelSlackTask(canceled.id);
      await first.beginSlackBatchAcknowledgment([research.id, canceled.id]);
      await first.close();

      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        await second.recoverSlackResearchTasks();
        expect((await second.getSlackTask(research.id))?.ackState).toBe("failed");
        expect((await second.getSlackTask(research.id))?.state).toBe("queued");
        expect((await second.getSlackTask(canceled.id))?.ackState).toBe("failed");
        expect(await second.listSlackPendingThreads()).toEqual([]);
        expect((await second.claimSlackResearchTask())?.id).toBe(research.id);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("recovers an approved research answer for posting without another decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-approved-restart-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      await first.followSlackThread(key, "1.1");
      await first.recordSlackMessage(key, "1.1");
      await first.markSlackMessagesProcessed(key, ["1.1"]);
      const task = (await first.createSlackTask({ type: "research", thread: key, sourceTs: "1.1", requestIndex: 1, request: "Question", quote: "Question" })).task;
      await first.claimSlackResearchTask();
      await first.completeSlackResearchTask(task.id, "Answer");
      await first.approveSlackResearchResult(task.id);
      await first.close();

      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        expect(await second.listSlackPendingThreads()).toEqual([key]);
        expect((await second.getSlackTask(task.id))?.state).toBe("approved");
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands a Slack-created ticket to the scheduler on the same task row", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      const slackTask = (await db.createSlackTask({ type: "coding", delegateToBearMetal: true, thread: key, sourceTs: "2.1", requestIndex: 1, request: "Implement the change" })).task;
      await db.attachSlackTicket(slackTask.id, "ticket-1", "https://linear.app/ticket-1");
      expect(await db.listTracked()).toEqual([]);
      expect(await db.countTracked()).toBe(0);
      await db.upsertTicketDiscovered({
        id: "ticket-1", identifier: "DEN-1", title: "Implement the change", description: "Details",
        url: "https://linear.app/ticket-1", branchName: "feature/den-1", linearStatusName: "Todo",
        linearStatusType: "unstarted", labels: [],
      });
      const dispatched = await db.enqueue({ state: "new", ticketId: "DEN-1", ticketIssueId: "ticket-1", prs: [], trigger: "new" });
      expect(dispatched.id).toBe(slackTask.id);
      expect((await db.getSlackTask(slackTask.id))?.ticketId).toBe("ticket-1");
      expect((await db.listTracked())[0]?.latestTask.id).toBe(slackTask.id);
      expect(await db.countTracked()).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("restores unprocessed messages and requeues unfinished research from durable state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-slack-restart-"));
    const url = `sqlite:${join(dir, "db.sqlite")}`;
    const first = new SqlDbClient(url, 5);
    try {
      await first.initSchema();
      await first.followSlackThread(key, "1.1");
      await first.recordSlackMessage(key, "1.1");
      const task = (await first.createSlackTask({ type: "research", thread: key, sourceTs: "1.1", requestIndex: 1, request: "Question", quote: "Question" })).task;
      await first.claimSlackResearchTask();
      await first.startAgentRun({ type: "research", id: task.id, request: "Question", slack: { ...key, sourceTs: "1.1" } }, null, null);
      await first.close();

      const second = new SqlDbClient(url, 5);
      await second.initSchema();
      try {
        await second.recoverSlackResearchTasks();
        expect(await second.listSlackPendingThreads()).toEqual([key]);
        expect(await second.listSlackPendingMessages(key)).toEqual(["1.1"]);
        expect(await second.listTracked()).toEqual([]);
        expect(await second.countTracked()).toBe(0);
        expect((await second.getAgentRunDetail(task.id))?.run.status).toBe("crashed");
        expect((await second.getAgentRunDetail(task.id))?.run.stopReason).toBe("crash");
        expect((await second.claimSlackResearchTask())?.id).toBe(task.id);
        await second.startAgentRun({ type: "research", id: task.id, request: "Question", slack: { ...key, sourceTs: "1.1" } }, null, null);
        expect((await second.getAgentRunDetail(task.id))?.run.status).toBe("running");
        expect((await second.getAgentRunDetail(task.id))?.run.stopReason).toBeNull();
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
