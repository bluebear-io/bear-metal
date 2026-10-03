import request from "supertest";
import { describe, expect, it } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createApp } from "./app.js";
import type { LinearSource } from "./scheduler.js";

describe("agent run API", () => {
  it("lists coding tickets, research tasks, and coordinator executions together", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      await db.upsertTicketDiscovered({ id: "lin-1", identifier: "DEN-1", title: "Fix parser", description: null,
        url: "https://linear.app/issue/DEN-1", branchName: "feature/den-1", linearStatusName: "Todo",
        linearStatusType: "unstarted", labels: ["bear-metal"] });
      const research = await db.createSlackTask({ type: "research", thread: { workspaceId: "T1", channelId: "C1", threadTs: "100.0" },
        sourceTs: "102.0", requestIndex: 1, request: "What is 2 + 2?", quote: "What is 2 + 2?" });
      await db.startAgentRun({ id: "coord-1", type: "coordinator", slack: { workspaceId: "T1", channelId: "C1", threadTs: "100.0", sourceTs: "101.0" } }, "anthropic", "claude");
      await db.finishAgentRun("coord-1", null);
      const app = createApp(db, 5, { getTicketAssignees: async () => new Map() } as unknown as LinearSource);
      const response = await request(app).get("/api/tasks?pageSize=2");
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(3);
      const second = await request(app).get("/api/tasks?page=2&pageSize=2");
      expect([...response.body.tasks, ...second.body.tasks].map((task: { type: string }) => task.type).sort())
        .toEqual(["coding", "coordinator", "research"]);
      expect([...response.body.tasks, ...second.body.tasks].find((task: { type: string }) => task.type === "research"))
        .toMatchObject({ id: research.task.id, title: "What is 2 + 2?" });
      expect((await request(app).get("/api/tasks?type=research")).body.total).toBe(1);
      expect((await request(app).get("/api/tasks?q=2%20%2B%202")).body.tasks).toMatchObject([{ id: research.task.id }]);
      expect((await request(app).get("/api/tasks?statuses=succeeded")).body.tasks).toMatchObject([{ id: "coord-1" }]);
      expect((await request(app).get("/api/tasks?type=unknown")).status).toBe(400);
    } finally {
      await db.close();
    }
  });

  it("serves coordinator trace and rejects invalid pages", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      await db.startAgentRun({ id: "coord-1", type: "coordinator", slack: { workspaceId: "T1", channelId: "C1", threadTs: "100.0", sourceTs: "101.0" } }, "anthropic", "claude");
      await db.recordAgentTrace("coord-1", "assistant_text", JSON.stringify({ text: "Ignored local test" }));
      await db.finishAgentRun("coord-1", null);
      const app = createApp(db, 5, {} as LinearSource);
      expect((await request(app).get("/api/agent-runs?page=0")).status).toBe(400);
      const list = await request(app).get("/api/agent-runs");
      expect(list.status).toBe(200);
      expect(list.body.items[0]).toMatchObject({ id: "coord-1", type: "coordinator", status: "succeeded" });
      const detail = await request(app).get("/api/agent-runs/coord-1");
      expect(detail.status).toBe(200);
      expect(detail.body.trace).toMatchObject([{ kind: "assistant_text", contentJson: JSON.stringify({ text: "Ignored local test" }) }]);
    } finally {
      await db.close();
    }
  });
});
