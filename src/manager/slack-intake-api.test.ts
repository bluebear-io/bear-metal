import { describe, expect, it, vi } from "vitest";
import { SlackIntakeApi } from "./slack-intake-api.js";

describe("Reaction thread context", () => {
  it("reads every page of the reacted thread", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "100.0", user: "U1", text: "request" }], response_metadata: { next_cursor: "next" } })
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "200.0", thread_ts: "100.0", user: "U2", text: "context" }] });
    const result = await new SlackIntakeApi({ call }).readMessageThread("C1", "100.0");
    expect(result.threadTs).toBe("100.0");
    expect(result.messages.map(message => message.text)).toEqual(["request", "context"]);
    expect(call.mock.calls[1]![1]).toMatchObject({ cursor: "next", ts: "100.0" });
  });
  it("rejects incomplete pagination rather than returning partial thread context", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, has_more: true, messages: [{ ts: "100.0", user: "U1", text: "request" }] });
    await expect(new SlackIntakeApi({ call }).readMessageThread("C1", "100.0")).rejects.toThrow("no pagination cursor");
  });
});
