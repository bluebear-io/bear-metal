import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlDbClient, type SlackThreadKey } from "./client.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "1.0" };

async function withFileDb(run: (db: SqlDbClient, path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bear-metal-slack-results-"));
  const path = join(dir, "db.sqlite");
  const db = new SqlDbClient(`sqlite:${path}`, 5);
  try {
    await db.initSchema();
    await run(db, path);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function dispatchSlackCodingTask(db: SqlDbClient): Promise<string> {
  const slackTask = (await db.createSlackTask({ type: "coding", thread: key, sourceTs: "2.1", requestIndex: 1, request: "Implement the change" })).task;
  await db.attachSlackTicket(slackTask.id, "ticket-1", "https://linear.app/ticket-1");
  await db.upsertTicketDiscovered({
    id: "ticket-1", identifier: "DEN-1", title: "Implement the change", description: "Details",
    url: "https://linear.app/ticket-1", branchName: "feature/den-1", linearStatusName: "Todo",
    linearStatusType: "unstarted", labels: [],
  });
  await db.enqueue({ state: "new", ticketId: "DEN-1", ticketIssueId: "ticket-1", prs: [], trigger: "new" });
  const acquired = await db.acquireNext("worker-1");
  if (acquired?.id !== slackTask.id) throw new Error("Slack coding task was not dispatched");
  return slackTask.id;
}

function overwriteResult(path: string, id: string, resultJson: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.prepare("UPDATE tasks SET result_json = ? WHERE id = ?").run(resultJson, id);
  } finally {
    raw.close();
  }
}

describe("Slack thread task results", () => {
  it("lists a completed coding task alongside research without exposing its outcome as a research answer", async () => {
    await withFileDb(async (db) => {
      const codingId = await dispatchSlackCodingTask(db);
      await db.complete(codingId, { status: "done", prs: [{ owner: "bluebear-io", repo: "bluebear-iac", number: 220 }] });
      const research = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "2.2", requestIndex: 1, request: "Explain X", quote: "X" })).task;
      expect((await db.claimSlackResearchTask())?.id).toBe(research.id);
      await db.completeSlackResearchTask(research.id, "Answer", "Summary");

      const tasks = await db.listSlackThreadTasks(key);
      expect(tasks.find((task) => task.id === codingId)).toEqual(expect.objectContaining({ type: "coding", result: null, summary: null }));
      expect(tasks.find((task) => task.id === research.id)).toEqual(expect.objectContaining({ type: "research", result: "Answer", summary: "Summary" }));
    });
  });

  it("lists a coding task whose crashed run was recovered with a pending outcome", async () => {
    await withFileDb(async (db) => {
      const codingId = await dispatchSlackCodingTask(db);
      expect((await db.markCrashed(codingId, "worker-1", 1))?.action).toBe("abandoned");
      expect((await db.getSlackTask(codingId))?.type).toBe("coding");
    });
  });

  it("rejects a malformed coding outcome", async () => {
    await withFileDb(async (db, path) => {
      const codingId = await dispatchSlackCodingTask(db);
      await db.complete(codingId, { status: "done", prs: [] });
      overwriteResult(path, codingId, JSON.stringify({ answer: "Research-shaped answer" }));
      await expect(db.listSlackThreadTasks(key)).rejects.toThrow("Invalid dispatch result status");
    });
  });

  it.each([
    ["empty JSON", "", "not valid JSON"],
    ["non-JSON text", "not json", "not valid JSON"],
    ["a non-object payload", JSON.stringify([]), "must be an object"],
    ["an invalid status", JSON.stringify({ status: "finished", prs: [] }), "Invalid dispatch result status"],
    ["a missing PR collection", JSON.stringify({ status: "done" }), "missing prs"],
    ["a non-array PR collection", JSON.stringify({ status: "done", prs: "invalid" }), "prs must be an array"],
    ["an empty PR reference", JSON.stringify({ status: "done", prs: [{}] }), "owner must be a non-empty string"],
    ["a non-object PR reference", JSON.stringify({ status: "done", prs: ["bluebear-io/bear-metal#1"] }), "PullRequestRef must be an object"],
    ["an invalid PR number", JSON.stringify({ status: "done", prs: [{ owner: "bluebear-io", repo: "bear-metal", number: "1" }] }), "number must be a positive integer"],
    ["an invalid legacy PR reference", JSON.stringify({ status: "done", pr: { owner: "bluebear-io" } }), "repo must be a non-empty string"],
    ["an invalid notify flag", JSON.stringify({ status: "done", prs: [], notifyOnComplete: "yes" }), "notifyOnComplete must be a boolean"],
  ])("rejects a coding outcome with %s", async (_name, resultJson, message) => {
    await withFileDb(async (db, path) => {
      const codingId = await dispatchSlackCodingTask(db);
      await db.complete(codingId, { status: "done", prs: [] });
      overwriteResult(path, codingId, resultJson);
      await expect(db.listSlackThreadTasks(key)).rejects.toThrow(`Coding task ${codingId} has an invalid result`);
      await expect(db.getSlackTask(codingId)).rejects.toThrow(message);
    });
  });

  it.each([
    ["a completed outcome with PRs", JSON.stringify({ status: "done", prs: [{ owner: "bluebear-io", repo: "bluebear-iac", number: 220 }] })],
    ["a completed outcome with notification flag", JSON.stringify({ status: "done", prs: [], notifyOnComplete: true })],
    ["a recovered pending outcome", JSON.stringify({ status: "pending", prs: [] })],
    ["a legacy single PR outcome", JSON.stringify({ status: "done", pr: { owner: "bluebear-io", repo: "bear-metal", number: 7 } })],
    ["a legacy outcome without a PR", JSON.stringify({ status: "pending", pr: null })],
  ])("reads a coding task with %s", async (_name, resultJson) => {
    await withFileDb(async (db, path) => {
      const codingId = await dispatchSlackCodingTask(db);
      await db.complete(codingId, { status: "done", prs: [] });
      overwriteResult(path, codingId, resultJson);
      const expected = expect.objectContaining({ id: codingId, type: "coding", result: null, summary: null });
      expect(await db.listSlackThreadTasks(key)).toEqual([expected]);
      expect(await db.getSlackTask(codingId)).toEqual(expected);
    });
  });

  it("rejects research results that are not JSON objects", async () => {
    await withFileDb(async (db, path) => {
      const research = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "2.2", requestIndex: 1, request: "Explain X", quote: "X" })).task;
      expect((await db.claimSlackResearchTask())?.id).toBe(research.id);
      await db.completeSlackResearchTask(research.id, "Answer");
      overwriteResult(path, research.id, "");
      await expect(db.listSlackThreadTasks(key)).rejects.toThrow(`Research task ${research.id} has an invalid result`);
      overwriteResult(path, research.id, "null");
      await expect(db.getSlackTask(research.id)).rejects.toThrow(`Research task ${research.id} has an invalid result`);
    });
  });

  it("rejects a malformed research answer", async () => {
    await withFileDb(async (db, path) => {
      const research = (await db.createSlackTask({ type: "research", thread: key, sourceTs: "2.2", requestIndex: 1, request: "Explain X", quote: "X" })).task;
      expect((await db.claimSlackResearchTask())?.id).toBe(research.id);
      await db.completeSlackResearchTask(research.id, "Answer");
      overwriteResult(path, research.id, JSON.stringify({ status: "done", prs: [] }));
      await expect(db.listSlackThreadTasks(key)).rejects.toThrow(`Research task ${research.id} has an invalid result`);
    });
  });
});
