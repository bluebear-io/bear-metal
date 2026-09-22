import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentToolTransport,
  enforcePaginationBudget,
  normalizeAgentToolError,
  redactCredentials,
  validateArchiveEntries,
} from "./transport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentToolTransport", () => {
  it("retries read failures within budget and returns bounded text metadata", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary failure"))
      .mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "text/plain" } }));
    const transport = new AgentToolTransport({ fetch, retryDelayMs: 0 });

    const result = await transport.get("https://example.com/data", {
      source: { provider: "web", resource: "https://example.com/data" },
      maxAttempts: 2,
      maxCompressedBytes: 100,
      maxDecompressedBytes: 100,
      maxModelBytes: 100,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ data: "hello", bytes: { compressed: 5, decompressed: 5, returned: 5 }, truncated: false });
  });

  it("stores permitted binary responses under the dedicated artifact directory", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tool-transport-"));
    temporaryDirectories.push(workspaceRoot);
    const transport = new AgentToolTransport({
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } })),
    });

    const result = await transport.get("https://example.com/archive", {
      source: { provider: "github", resource: "/repos/acme/repo/actions/artifacts/1" },
      workspaceRoot,
      responseMode: "artifact",
      allowedContentTypes: ["application/octet-stream"],
      maxCompressedBytes: 100,
      maxDecompressedBytes: 100,
      maxModelBytes: 100,
    });

    expect(result.artifact?.path).toMatch(/\.bear-metal\/agent-tool-artifacts\//);
    expect(await readFile(result.artifact!.path)).toEqual(Buffer.from([1, 2, 3]));
    expect(result.data).toBeUndefined();
  });

  it("rejects oversized and unsupported responses before returning content", async () => {
    const oversized = new AgentToolTransport({ fetch: vi.fn(async () => new Response("too large")) });
    await expect(oversized.get("https://example.com", {
      source: { provider: "web", resource: "https://example.com" },
      maxCompressedBytes: 3,
      maxDecompressedBytes: 100,
      maxModelBytes: 100,
    })).rejects.toMatchObject({ code: "response_too_large" });

    const unsupported = new AgentToolTransport({
      fetch: vi.fn(async () => new Response("data", { headers: { "content-type": "application/x-custom" } })),
    });
    await expect(unsupported.get("https://example.com", {
      source: { provider: "web", resource: "https://example.com" },
      allowedContentTypes: ["application/json"],
      maxCompressedBytes: 100,
      maxDecompressedBytes: 100,
      maxModelBytes: 100,
    })).rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it("redacts credentials and normalizes provider failures", () => {
    expect(redactCredentials({ authorization: "Bearer secret", nested: { token: "abc", value: "safe" }, url: "https://x.test?a=1&signature=secret" })).toEqual({
      authorization: "[REDACTED]",
      nested: { token: "[REDACTED]", value: "safe" },
      url: "https://x.test/?a=1&signature=%5BREDACTED%5D",
    });
    expect(normalizeAgentToolError(new Error("Authorization: Bearer secret"), "github")).toMatchObject({
      code: "provider_error",
      provider: "github",
      message: "Authorization: [REDACTED]",
    });
    expect(normalizeAgentToolError(new Error("provider echoed github_pat_abc123 and xoxb-123-456"), "github").message).toBe("provider echoed [REDACTED] and [REDACTED]");
  });

  it("bounds pagination budgets", () => {
    expect(enforcePaginationBudget(undefined, 5)).toBe(1);
    expect(enforcePaginationBudget(10, 5)).toBe(5);
    expect(() => enforcePaginationBudget(0, 5)).toThrow(/positive integers/);
  });
});

describe("validateArchiveEntries", () => {
  it("accepts bounded safe entries and rejects traversal, file-count, size, and content-type violations", () => {
    expect(() => validateArchiveEntries([{ path: "logs/run.txt", expandedBytes: 10, contentType: "text/plain" }], {
      maxFiles: 1,
      maxExpandedBytes: 10,
      allowedContentTypes: ["text/plain"],
    })).not.toThrow();
    expect(() => validateArchiveEntries([{ path: "../secret", expandedBytes: 1, contentType: "text/plain" }], { maxFiles: 1, maxExpandedBytes: 10 })).toThrow(/path/);
    expect(() => validateArchiveEntries([{ path: "a", expandedBytes: 1 }, { path: "b", expandedBytes: 1 }], { maxFiles: 1, maxExpandedBytes: 10 })).toThrow(/file count/);
    expect(() => validateArchiveEntries([{ path: "a", expandedBytes: 11 }], { maxFiles: 1, maxExpandedBytes: 10 })).toThrow(/expanded size/);
    expect(() => validateArchiveEntries([{ path: "a", expandedBytes: 1, contentType: "application/x-executable" }], { maxFiles: 1, maxExpandedBytes: 10, allowedContentTypes: ["text/plain"] })).toThrow(/content type/);
  });
});
