import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlDbClient } from "./client.js";

const dirs: string[] = [];

async function makeDb(): Promise<SqlDbClient> {
  const dir = await mkdtemp(join(tmpdir(), "bear-metal-run-cost-"));
  dirs.push(dir);
  const db = new SqlDbClient(`sqlite:${join(dir, "test.sqlite")}`, 5);
  await db.initSchema();
  return db;
}

describe("run USD cost", () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("persists coding run cost and exposes it on the ticket detail and agent run", async () => {
    const db = await makeDb();
    try {
      await db.upsertTicketDiscovered({
        id: "lin_1", identifier: "ABC-1", title: "Ticket", description: null, url: "https://linear.app/x/issue/ABC-1",
        branchName: "feature/abc-1", linearStatusName: "In Progress", linearStatusType: "started", labels: [],
      });
      const priced = await db.enqueue({ state: "new", ticketId: "ABC-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
      await db.upsertRunStarted(priced.id, "worker-1", "2026-10-07T10:00:00.000Z");
      await db.upsertRunSucceeded(priced.id, {
        promptTokens: 120_000, completionTokens: 4_000, costUsd: 1.875, modelName: "Claude Opus", provider: "anthropic",
      });
      await db.complete(priced.id, { status: "pending", prs: [] });
      const unpriced = await db.enqueue({ state: "new", ticketId: "ABC-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
      await db.upsertRunStarted(unpriced.id, "worker-1", "2026-10-07T11:00:00.000Z");
      await db.upsertRunSucceeded(unpriced.id, {
        promptTokens: 1_000, completionTokens: 10, costUsd: null, modelName: "Custom", provider: "custom",
      });

      const detail = await db.getTicketDetail("lin_1");
      expect(detail?.runs.map((run) => run.costUsd)).toEqual([1.875, null]);
      expect((await db.getAgentRunDetail(priced.id))?.run.costUsd).toBe(1.875);
    } finally {
      await db.close();
    }
  });

  it("clears a stored cost when a later succeeded write reports an unpriced run", async () => {
    const db = await makeDb();
    try {
      await db.upsertTicketDiscovered({
        id: "lin_2", identifier: "ABC-2", title: "Ticket", description: null, url: "https://linear.app/x/issue/ABC-2",
        branchName: "feature/abc-2", linearStatusName: "In Progress", linearStatusType: "started", labels: [],
      });
      const task = await db.enqueue({ state: "new", ticketId: "ABC-2", prs: [], trigger: "new", ticketIssueId: "lin_2" });
      await db.upsertRunStarted(task.id, "worker-1", "2026-10-07T10:00:00.000Z");
      await db.upsertRunSucceeded(task.id, {
        promptTokens: 100, completionTokens: 10, costUsd: 0.5, modelName: "Claude Opus", provider: "anthropic",
      });
      await db.upsertRunSucceeded(task.id, {
        promptTokens: 200, completionTokens: 20, costUsd: null, modelName: "Custom", provider: "custom",
      });
      expect((await db.getAgentRunDetail(task.id))?.run).toMatchObject({ promptTokens: 200, costUsd: null });

      await db.upsertRunSucceeded(task.id, null);
      expect((await db.getAgentRunDetail(task.id))?.run).toMatchObject({ promptTokens: 200, costUsd: null });
    } finally {
      await db.close();
    }
  });

  it("persists coordinator and research run cost", async () => {
    const db = await makeDb();
    try {
      const thread = { workspaceId: "T1", channelId: "C1", threadTs: "100.0" };
      await db.startAgentRun({ id: "coordinator-1", type: "coordinator", request: "coordinate", slack: { ...thread, sourceTs: "101.0" } }, "anthropic", "claude");
      await db.setAgentRunUsage("coordinator-1", 5_000, 200, 0.042);
      await db.finishAgentRun("coordinator-1", null);

      const run = (await db.getAgentRunDetail("coordinator-1"))?.run;
      expect(run).toMatchObject({ promptTokens: 5_000, completionTokens: 200, costUsd: 0.042 });
      expect((await db.listAgentRuns(1, 20)).items.find((item) => item.id === "coordinator-1")?.costUsd).toBe(0.042);
    } finally {
      await db.close();
    }
  });
});
