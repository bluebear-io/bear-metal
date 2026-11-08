import { describe, expect, it, vi } from "vitest";
import { SlackIntakeApi } from "./slack-intake-api.js";

describe("Slack intake pagination", () => {
  it("reads history lazily without discarding older pages or including the prior cursor", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "300.0", user: "U1", text: "new" }], response_metadata: { next_cursor: "next" } })
      .mockResolvedValueOnce({ ok: true, messages: [{ ts: "200.0", user: "U1", text: "older" }, { ts: "100.0", user: "U1", text: "already reviewed" }] });
    const pages = new SlackIntakeApi({ call }).historyPages("C1", "100.0", "300.0");
    expect(call).not.toHaveBeenCalled();
    expect((await pages.next()).value).toEqual([expect.objectContaining({ ts: "300.0" })]);
    expect(call).toHaveBeenCalledTimes(1);
    expect((await pages.next()).value).toEqual([expect.objectContaining({ ts: "200.0" })]);
    expect(call.mock.calls[1]![1]).toMatchObject({ cursor: "next", oldest: "100.0", latest: "300.0" });
    expect((await pages.next()).done).toBe(true);
  });
  it("bounds thread reads to the sweep snapshot and rejects broken pagination", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, has_more: true, messages: [{ ts: "200.0", user: "U1", text: "in window" }, { ts: "400.0", user: "U1", text: "later" }] });
    const pages = new SlackIntakeApi({ call }).threadPages("C1", "100.0", "300.0");
    expect((await pages.next()).value).toEqual([expect.objectContaining({ ts: "200.0" })]);
    await expect(pages.next()).rejects.toThrow("no pagination cursor");
    expect(call.mock.calls[0]![1]).toMatchObject({ ts: "100.0", latest: "300.0", limit: 100 });
  });
});
