import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../logger.js";
import { formatNeedsInputText, formatNotificationText, SlackIntegration } from "./client.js";

const SILENT_LOGGER = createLogger({ name: "slack-test", level: "silent" });

describe("formatNotificationText", () => {
  it("formats an 'opened' message", () => {
    const text = formatNotificationText({
      kind: "opened",
      pr: { owner: "acme", repo: "repo", number: 42 },
      title: "Add slack notifier",
      url: "https://github.com/acme/repo/pull/42",
      ticketId: "PROJ-4",
      ticketUrl: "https://linear.app/x/PROJ-4",
    });
    expect(text).toBe(
      ":bear: PR opened <https://github.com/acme/repo/pull/42|acme/repo#42> for ticket <https://linear.app/x/PROJ-4|PROJ-4> — Add slack notifier",
    );
  });

  it("escapes Slack mrkdwn special chars in title and ticket id to prevent link injection", () => {
    const text = formatNotificationText({
      kind: "opened",
      pr: { owner: "acme", repo: "repo", number: 1 },
      title: "Check <https://evil.com|this> & stuff",
      url: "https://github.com/acme/repo/pull/1",
      ticketId: "ABC-<1>",
      ticketUrl: "https://linear.app/x/ABC-1",
    });
    expect(text).toContain("Check &lt;https://evil.com|this&gt; &amp; stuff");
    expect(text).toContain("ABC-&lt;1&gt;");
    expect(text).not.toContain("<https://evil.com|this>");
  });

  it("formats an 'updated' message with ticket link", () => {
    const text = formatNotificationText({
      kind: "updated",
      pr: { owner: "acme", repo: "repo", number: 7 },
      title: "Fix flakes",
      url: "https://github.com/acme/repo/pull/7",
      ticketId: "ABC-9",
      ticketUrl: "https://linear.app/x/ABC-9",
    });
    expect(text).toBe(
      "Updated PR <https://github.com/acme/repo/pull/7|acme/repo#7> for ticket <https://linear.app/x/ABC-9|ABC-9> — Fix flakes",
    );
  });
});

describe("formatNeedsInputText", () => {
  it("formats a needs-input message with raising_hand icon and ticket link", () => {
    const text = formatNeedsInputText({
      ticketId: "PROJ-5",
      ticketUrl: "https://linear.app/x/PROJ-5",
      title: "fix the widget",
    });
    expect(text).toBe(
      ":raising_hand: Needs your input on ticket <https://linear.app/x/PROJ-5|PROJ-5> — fix the widget",
    );
  });

  it("escapes mrkdwn special chars in ticket id", () => {
    const text = formatNeedsInputText({
      ticketId: "ABC-<99>",
      ticketUrl: "https://linear.app/x/ABC-99",
      title: "some ticket",
    });
    expect(text).toContain("ABC-&lt;99&gt;");
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
      pr: { owner: "acme", repo: "repo", number: 1 },
      title: "Hello",
      url: "https://example.com/pr/1",
      ticketId: "ABC-1",
      ticketUrl: "https://linear.app/x/ABC-1",
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
        pr: { owner: "acme", repo: "repo", number: 2 },
        title: "Hi",
        url: "https://example.com/pr/2",
        ticketId: "ABC-2",
        ticketUrl: "https://linear.app/x/ABC-2",
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
        pr: { owner: "acme", repo: "repo", number: 3 },
        title: "Hi",
        url: "https://example.com/pr/3",
        ticketId: "ABC-3",
        ticketUrl: "https://linear.app/x/ABC-3",
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
        pr: { owner: "acme", repo: "repo", number: 4 },
        title: "Hi",
        url: "https://example.com/pr/4",
        ticketId: "ABC-4",
        ticketUrl: "https://linear.app/x/ABC-4",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when constructed without a token or channel", () => {
    expect(() => new SlackIntegration({ token: "", channel: "C1", logger: SILENT_LOGGER })).toThrow();
    expect(() => new SlackIntegration({ token: "xoxb", channel: "", logger: SILENT_LOGGER })).toThrow();
  });

  it("sends a DM when recipientEmail resolves to a Slack user", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, user: { id: "U9876" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
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
      pr: { owner: "acme", repo: "repo", number: 1 },
      title: "Hello",
      url: "https://example.com/pr/1",
      ticketId: "ABC-1",
      ticketUrl: "https://linear.app/x/ABC-1",
      recipientEmail: "user@example.com",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [lookupUrl] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(lookupUrl).toBe("https://slack.com/api/users.lookupByEmail?email=user%40example.com");
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(postInit?.body as string);
    expect(body.channel).toBe("U9876");
  });

  it("falls back to channel when users.lookupByEmail returns users_not_found", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "users_not_found" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
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
      pr: { owner: "acme", repo: "repo", number: 1 },
      title: "Hello",
      url: "https://example.com/pr/1",
      ticketId: "ABC-1",
      ticketUrl: "https://linear.app/x/ABC-1",
      recipientEmail: "unknown@example.com",
    });

    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(postInit?.body as string);
    expect(body.channel).toBe("C12345");
  });

  it("falls back to channel when users.lookupByEmail returns an HTTP error", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(
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
      pr: { owner: "acme", repo: "repo", number: 1 },
      title: "Hello",
      url: "https://example.com/pr/1",
      ticketId: "ABC-1",
      ticketUrl: "https://linear.app/x/ABC-1",
      recipientEmail: "user@example.com",
    });

    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(postInit?.body as string);
    expect(body.channel).toBe("C12345");
  });

  it("notifyNeedsInput posts raising_hand message to channel", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await slack.notifyNeedsInput({
      ticketId: "PROJ-5",
      ticketUrl: "https://linear.app/x/PROJ-5",
      title: "fix the widget",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, postInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(postInit?.body as string);
    expect(body.channel).toBe("C12345");
    expect(body.text).toContain(":raising_hand:");
    expect(body.text).toContain("PROJ-5");
  });

  it("notifyNeedsInput DMs the assignee when recipientEmail resolves", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, user: { id: "UABC" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    const slack = new SlackIntegration({
      token: "xoxb-test",
      channel: "C12345",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: SILENT_LOGGER,
    });

    await slack.notifyNeedsInput({
      ticketId: "PROJ-5",
      ticketUrl: "https://linear.app/x/PROJ-5",
      title: "fix the widget",
      recipientEmail: "user@example.com",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, postInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(postInit?.body as string);
    expect(body.channel).toBe("UABC");
    expect(body.text).toContain(":raising_hand:");
  });
});
