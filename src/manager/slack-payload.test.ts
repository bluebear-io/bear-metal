import { describe, expect, it } from "vitest";
import type { SlackThreadKey } from "../db/client.js";
import { buildCoordinatorPayload } from "./slack-payload.js";

const key: SlackThreadKey = { workspaceId: "T1", channelId: "C1", threadTs: "1.0" };

describe("Slack coordinator payload", () => {
  it("keeps all message references and reports both per-message and aggregate truncation", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      ts: `1.${index + 1}`, user: "U1", text: "x".repeat(10_000),
    }));
    const payload = JSON.parse(buildCoordinatorPayload(key, messages.map((message) => message.ts), messages, []));
    expect(payload.messages).toHaveLength(10);
    expect(payload.messages[0].text).toHaveLength(8_000);
    expect(payload.messages[0].readReference).toEqual({ channel: "C1", threadTs: "1.0", messageTs: "1.1" });
    expect(payload.messages[8].text).toHaveLength(0);
    expect(payload.messages[8].truncated).toBe(true);
    expect(payload.truncation).toMatchObject({
      any: true, totalCharacters: 100_000, includedCharacters: 64_000, omittedCharacters: 36_000,
    });
  });
});
