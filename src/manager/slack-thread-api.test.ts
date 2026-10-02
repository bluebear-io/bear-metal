import { describe, expect, it, vi } from "vitest";
import type { SlackReadClient, SlackIntegration } from "../shared/integrations/slack/client.js";
import { SlackThreadApi } from "./slack-thread-api.js";

describe("Slack thread reader", () => {
  it("reads the requesting user's Slack email", async () => {
    const call = vi.fn(async () => ({ ok: true, user: { id: "U1", profile: { email: "user@example.com" } } }));
    const api = new SlackThreadApi({ call } as unknown as SlackReadClient, {} as SlackIntegration);
    await expect(api.getUserEmail("U1")).resolves.toBe("user@example.com");
    expect(call).toHaveBeenCalledWith("users.info", { user: "U1" });
  });
  it("bounds an edited message read to its original timestamp", async () => {
    const call = vi.fn(async () => ({ ok: true, messages: [{ ts: "100.1", user: "U1", text: "edited" }] }));
    const api = new SlackThreadApi({ call } as unknown as SlackReadClient, {} as SlackIntegration);
    const messages = await api.readThread({ workspaceId: "T1", channelId: "C1", threadTs: "100.0" }, "100.1", "100.1");
    expect(messages.map((message) => message.ts)).toEqual(["100.1"]);
    expect(call).toHaveBeenCalledWith("conversations.replies", { channel: "C1", ts: "100.0", oldest: "100.1", latest: "100.1", inclusive: true, limit: 1 });
  });
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
