import { describe, expect, it, vi } from "vitest";
import type { SlackReadClient, SlackIntegration } from "../shared/integrations/slack/client.js";
import { SlackThreadApi } from "./slack-thread-api.js";

describe("Slack thread reader", () => {
  it("starts at the oldest pending reply inclusively and paginates forward", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "100.2", user: "U1", text: "pending" }], has_more: true, response_metadata: { next_cursor: "next" } })
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "100.3", user: "U2", text: "new" }], has_more: false });
    const api = new SlackThreadApi({ call } as unknown as SlackReadClient, {} as SlackIntegration);
    const messages = await api.readThread({ workspaceId: "T1", channelId: "C1", threadTs: "100.0" }, "100.2");
    expect(call).toHaveBeenNthCalledWith(1, "conversations.replies", { channel: "C1", ts: "100.0", oldest: "100.2", inclusive: true, limit: 200 });
    expect(call).toHaveBeenNthCalledWith(2, "conversations.replies", { channel: "C1", ts: "100.0", oldest: "100.2", inclusive: true, limit: 200, cursor: "next" });
    expect(messages.map((message) => message.ts)).toEqual(["100.2", "100.3"]);
  });
});
