import { describe, expect, it } from "vitest";
import { SqlDbClient } from "./client.js";

describe("agent execution history", () => {
  it("keeps coordinator and research runs visible after trace retention", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      const thread = { workspaceId: "T1", channelId: "C1", threadTs: "100.0" };
      const research = await db.createSlackTask({ type: "research", thread, sourceTs: "102.0", requestIndex: 1, request: "Find the answer", quote: "The answer?" });
      await db.claimSlackResearchTask();
      await db.startAgentRun({ id: research.task.id, type: "research" }, "anthropic", "claude");
      await db.completeSlackResearchTask(research.task.id, "42");
      await db.finishAgentRun(research.task.id, null);
      await db.startAgentRun({ id: "coordinator-1", type: "coordinator", request: "coordinate", slack: { ...thread, sourceTs: "101.0" } }, "anthropic", "claude");
      await db.recordAgentTrace("coordinator-1", "assistant_text", JSON.stringify({ text: "ignored test request" }), "2026-09-01T00:00:00.000Z");
      await db.recordAgentTrace("coordinator-1", "tool_call", JSON.stringify({ toolName: "ignore_message", result: "done" }), "2026-10-01T00:00:00.000Z");
      await db.finishAgentRun("coordinator-1", null);
      expect((await db.listAgentRuns(1, 20)).items.map((run) => run.id)).toContain("coordinator-1");
      expect((await db.listAgentRuns(1, 20)).items.map((run) => run.id)).toContain(research.task.id);
      expect((await db.getAgentRunDetail(research.task.id))?.run.resultJson).toContain("42");
      expect((await db.getAgentRunDetail("coordinator-1"))?.trace).toHaveLength(2);
      await db.purgeAgentTraces(14, new Date("2026-10-02T00:00:00.000Z"));
      expect((await db.getAgentRunDetail("coordinator-1"))?.trace).toHaveLength(1);
      expect((await db.getAgentRunDetail("coordinator-1"))?.run.status).toBe("succeeded");
    } finally {
      await db.close();
    }
  });
});
