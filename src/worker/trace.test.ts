import { describe, expect, it } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { AgentTraceWriter } from "./trace.js";

describe("agent trace writer", () => {
  it("keeps complete long assistant output in ordered bounded parts and redacts credentials", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    try {
      await db.startAgentRun({ id: "coord-1", type: "coordinator", slack: { workspaceId: "T", channelId: "C", threadTs: "100.0", sourceTs: "101.0" } }, null, null);
      const writer = new AgentTraceWriter(db, "coord-1");
      writer.record("assistant_text", { text: "x".repeat(9_000) });
      writer.record("tool_call", { toolName: "test", token: "secret-value" });
      await writer.flush();
      const events = (await db.getAgentRunDetail("coord-1"))!.trace;
      expect(events.map((event) => event.kind)).toEqual(["assistant_text", "assistant_text", "tool_call"]);
      expect(events.slice(0, 2).map((event) => JSON.parse(event.contentJson).text).join("")).toHaveLength(9_000);
      expect(events[2]!.contentJson).not.toContain("secret-value");
    } finally {
      await db.close();
    }
  });
});
