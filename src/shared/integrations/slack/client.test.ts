import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../logger.js";
import { formatNotificationText, SlackIntegration } from "./client.js";

const SILENT_LOGGER = createLogger({ name: "slack-test", level: "silent" });

describe("formatNotificationText", () => {
  it("formats an 'opened' message", () => {
    const text = formatNotificationText({
      kind: "opened",
      pr: { owner: "acme", repo: "blueden", number: 42 },
      title: "Add slack notifier",
      url: "https://github.com/acme/blueden/pull/42",
      ticketId: "DEN-2305",
      ticketUrl: "https://linear.app/x/DEN-2305",
    });
    expect(text).toBe(
      ":rocket: *PR opened* <https://github.com/acme/blueden/pull/42|acme/blueden#42> — Add slack notifier (ticket: <https://linear.app/x/DEN-2305|DEN-2305>)",
    );
  });

  it("escapes Slack mrkdwn special chars in title and ticket id to prevent link injection", () => {
    const text = formatNotificationText({
      kind: "opened",
      pr: { owner: "acme", repo: "blueden", number: 1 },
      title: "Check <https://evil.com|this> & stuff",
      url: "https://github.com/acme/blueden/pull/1",
      ticketId: "DEN-<1>",
    });
    expect(text).toContain("Check &lt;https://evil.com|this&gt; &amp; stuff");
    expect(text).toContain("(ticket: DEN-&lt;1&gt;)");
    expect(text).not.toContain("<https://evil.com|this>");
  });

  it("formats an 'updated' message and falls back to plain ticket id without url", () => { 
    const text = formatNotificationText({
      kind: "updated",
      pr: { owner: "acme", repo: "blueden", number: 7 },
      title: "Fix flakes",
      url: "https://github.com/acme/blueden/pull/7",
      ticketId: "DEN-9",
    });
    expect(text).toContain(":arrows_counterclockwise: *PR updated*");
    expect(text).toContain("(ticket: DEN-9)");
  });
});

describe("SlackIntegration", () => {
  it("posts to chat.postMessage with bearer token and channel", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await slack.notifyPullRequest({
      kind: "opened",
      pr: { owner: "acme", repo: "blueden", number: 1 },
      title: "Hello",
      url: "https://example.com/pr/1",
      ticketId: "DEN-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(init?.body as string);
    expect(body.channel).toBe("C12345");
    expect(body.text).toContain("PR opened");
  });

  it("logs errors but does not throw when Slack returns ok=false", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    );
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await expect(
      slack.notifyPullRequest({
        kind: "updated",
        pr: { owner: "acme", repo: "blueden", number: 2 },
        title: "Hi",
        url: "https://example.com/pr/2",
        ticketId: "DEN-2",
      }),
    ).resolves.toBeUndefined();
  });

  it("logs errors but does not throw on HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await expect(
      slack.notifyPullRequest({
        kind: "opened",
        pr: { owner: "acme", repo: "blueden", number: 3 },
        title: "Hi",
        url: "https://example.com/pr/3",
        ticketId: "DEN-3",
      }),
    ).resolves.toBeUndefined();
  });

  it("logs errors but does not throw when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await expect(
      slack.notifyPullRequest({
        kind: "opened",
        pr: { owner: "acme", repo: "blueden", number: 4 },
        title: "Hi",
        url: "https://example.com/pr/4",
        ticketId: "DEN-4",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when constructed without a token or channel", () => {
    expect(() => new SlackIntegration({ token: "", channel: "C1" })).toThrow();
    expect(() => new SlackIntegration({ token: "xoxb", channel: "" })).toThrow();
  });
});
