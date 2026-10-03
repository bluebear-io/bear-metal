import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "./client.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "1.0" };

describe("Slack restart recovery", () => {
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
      const slackTask = (await db.createSlackTask({ type: "coding", thread: key, sourceTs: "2.1", requestIndex: 1, request: "Implement the change" })).task;
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
