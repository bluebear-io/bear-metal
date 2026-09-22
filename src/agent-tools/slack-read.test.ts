import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackReadHandler } from "./slack-read.js";

const directories: string[] = [];
const context = (workspaceRoot = "/workspace") => ({ taskId: "DEN-1", runId: "run-1", workspaceRoot });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("slack_read", () => {
  it("maps structured operations and paginates within page and item budgets", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, channels: [{ id: "C1" }, { id: "C2" }], response_metadata: { next_cursor: "next" } })
      .mockResolvedValueOnce({ ok: true, channels: [{ id: "C3" }], response_metadata: { next_cursor: "more" } });
    const handler = createSlackReadHandler({ client: { call, downloadFile: vi.fn() } });

    const result = await handler({ operation: "conversation_discovery", parameters: { types: "public_channel" }, pageBudget: 2, itemLimit: 3 }, context());

    expect(call).toHaveBeenNthCalledWith(1, "conversations.list", { types: "public_channel", limit: 3 }, expect.any(Object));
    expect(call).toHaveBeenNthCalledWith(2, "conversations.list", { types: "public_channel", limit: 1, cursor: "next" }, expect.any(Object));
    expect(result).toMatchObject({
      source: { provider: "slack", resource: "conversations.list" },
      data: { items: [{ id: "C1" }, { id: "C2" }, { id: "C3" }] },
      pagination: { pages: 2, hasMore: true, next: "more" },
      truncated: true,
      truncationReason: "page_limit",
    });
  });

  it.each([
    ["conversation_info", { channel: "C1" }, "conversations.info"],
    ["conversation_history", { channel: "C1", oldest: 100, latest: 200 }, "conversations.history"],
    ["thread_replies", { channel: "C1", ts: "123.45" }, "conversations.replies"],
    ["user_lookup", { email: "person@example.com" }, "users.lookupByEmail"],
    ["user_list", {}, "users.list"],
    ["file_search", { channel: "C1" }, "files.list"],
  ])("maps %s to an allowlisted Slack API method", async (operation, parameters, method) => {
    const itemField = method === "users.list" ? "members" : method === "files.list" ? "files" : ["conversations.history", "conversations.replies"].includes(method) ? "messages" : undefined;
    const call = vi.fn(async () => ({ ok: true, ...(itemField ? { [itemField]: [] } : {}) }));
    const handler = createSlackReadHandler({ client: { call, downloadFile: vi.fn() } });

    const result = await handler({ operation, parameters }, context());

    expect(call).toHaveBeenCalledWith(method, expect.any(Object), expect.any(Object));
    expect(result.source.resource).toBe(method);
  });

  it("rejects unsupported operations, unknown parameters, and excessive history ranges before calling Slack", async () => {
    const call = vi.fn();
    const handler = createSlackReadHandler({
      client: { call, downloadFile: vi.fn() },
      limits: { maxHistoryRangeSeconds: 100 },
    });

    await expect(handler({ operation: "chat_post", parameters: {} }, context())).rejects.toMatchObject({ code: "invalid_operation" });
    await expect(handler({ operation: "message_search", parameters: { query: "deployment" } }, context())).rejects.toMatchObject({ code: "invalid_operation" });
    await expect(handler({ operation: "conversation_info", parameters: { channel: "C1", surprise: true } }, context())).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(handler({ operation: "conversation_history", parameters: { channel: "C1", oldest: 1, latest: 102 } }, context())).rejects.toMatchObject({ code: "history_range_limit" });
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces Slack required_scope on permission failures", async () => {
    const handler = createSlackReadHandler({
      client: { call: vi.fn(async () => ({ ok: false, error: "missing_scope", needed: "channels:history", provided: "channels:read" })), downloadFile: vi.fn() },
    });

    await expect(handler({ operation: "conversation_history", parameters: { channel: "C1" } }, context())).rejects.toMatchObject({
      code: "missing_scope",
      requiredScope: "channels:history",
      provider: "slack",
    });
  });

  it("downloads bounded files into the dedicated workspace artifact directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "slack-read-"));
    directories.push(workspaceRoot);
    const downloadFile = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf", "content-length": "3" },
    }));
    const handler = createSlackReadHandler({ client: { call: vi.fn(), downloadFile } });

    const result = await handler({ operation: "file_download", parameters: { url: "https://files.slack.com/files-pri/T1-F1/report.pdf" } }, context(workspaceRoot));

    expect(downloadFile).toHaveBeenCalledWith("https://files.slack.com/files-pri/T1-F1/report.pdf", expect.any(Object));
    expect(result.artifact?.path).toMatch(/\.bear-metal\/agent-tool-artifacts\/slack-/);
    expect(await readFile(result.artifact!.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(result.data).toBeUndefined();
  });

  it("rejects unsafe file URLs, redirects, content types, and oversized files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "slack-read-"));
    directories.push(workspaceRoot);
    const handler = createSlackReadHandler({
      client: { call: vi.fn(), downloadFile: vi.fn(async () => new Response("x", { headers: { "content-type": "application/x-executable" } })) },
      limits: { maxFileBytes: 1, allowedFileContentTypes: ["application/pdf"] },
    });

    await expect(handler({ operation: "file_download", parameters: { url: "http://files.slack.com/a" } }, context(workspaceRoot))).rejects.toMatchObject({ code: "invalid_file_url" });
    await expect(handler({ operation: "file_download", parameters: { url: "https://evil.example/a" } }, context(workspaceRoot))).rejects.toMatchObject({ code: "invalid_file_url" });
    await expect(handler({ operation: "file_download", parameters: { url: "https://files.slack.com/a" } }, context(workspaceRoot))).rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it("stops reading a file stream as soon as the byte limit is exceeded", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
        if (pulls === 3) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "slack-read-"));
    directories.push(workspaceRoot);
    const handler = createSlackReadHandler({
      client: { call: vi.fn(), downloadFile: vi.fn(async () => new Response(body, { headers: { "content-type": "application/pdf" } })) },
      limits: { maxFileBytes: 5 },
    });

    await expect(handler({ operation: "file_download", parameters: { url: "https://files.slack.com/a.pdf" } }, context(workspaceRoot))).rejects.toMatchObject({ code: "file_too_large" });
    expect(cancelled).toBe(true);
  });
});
