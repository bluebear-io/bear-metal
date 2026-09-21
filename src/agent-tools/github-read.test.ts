import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentToolError } from "./types.js";
import { createGitHubReadHandler } from "./github-read.js";

const context = (workspaceRoot: string) => ({ taskId: "DEN-4082", runId: "run-1", workspaceRoot });

describe("github_read", () => {
  it("uses the agent installation token and paginates a relative REST path with structured query", async () => {
    const getInstallationToken = vi.fn(async () => "agent-read-token");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          "content-type": "application/json",
          link: '<https://api.github.com/repos/acme/widgets/pulls?page=2&state=open>; rel="next"',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), {
        headers: { "content-type": "application/json" },
      }));
    const handler = createGitHubReadHandler({ tokenProvider: { getInstallationToken }, fetch });

    const result = await handler({
      path: "/repos/acme/widgets/pulls",
      query: { state: "open", labels: ["security", "agent"] },
      pageBudget: 2,
      responseMode: "inline",
    }, context(await mkdtemp(join(tmpdir(), "github-read-"))));

    expect(getInstallationToken).toHaveBeenCalledWith();
    expect(fetch).toHaveBeenNthCalledWith(1,
      "https://api.github.com/repos/acme/widgets/pulls?state=open&labels=security&labels=agent",
      expect.objectContaining({ method: "GET", redirect: "manual", headers: expect.objectContaining({ authorization: "Bearer agent-read-token" }) }),
    );
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.pagination).toEqual({ pages: 2, hasMore: false });
  });

  it("strips authorization while following a download redirect to another host", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/log.zip?signature=secret" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/zip" } }));
    const root = await mkdtemp(join(tmpdir(), "github-read-"));
    const handler = createGitHubReadHandler({ tokenProvider: { getInstallationToken: async () => "agent-read-token" }, fetch });

    const result = await handler({ path: "/repos/acme/widgets/actions/runs/1/logs", responseMode: "artifact" }, context(root));

    expect(fetch).toHaveBeenNthCalledWith(2, "https://objects.githubusercontent.com/log.zip?signature=secret",
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: expect.anything() }) }),
    );
    expect(await readFile(result.artifact!.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("reports GitHub permission context without exposing credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-accepted-github-permissions": "actions=read" },
    }));
    const handler = createGitHubReadHandler({ tokenProvider: { getInstallationToken: async () => "secret" }, fetch });

    await expect(handler({ path: "/repos/acme/widgets/actions/runs" }, context("/tmp"))).rejects.toMatchObject({
      code: "github_permission_denied",
      status: 403,
      message: expect.stringContaining("actions=read"),
    } satisfies Partial<AgentToolError>);
  });

  it("rejects absolute URLs and non-GET path tricks", async () => {
    const handler = createGitHubReadHandler({ tokenProvider: { getInstallationToken: async () => "secret" }, fetch: vi.fn() });
    await expect(handler({ path: "https://evil.example/repos/acme/widgets" }, context("/tmp"))).rejects.toMatchObject({ code: "invalid_github_path" });
    await expect(handler({ path: "//evil.example/repos/acme/widgets" }, context("/tmp"))).rejects.toMatchObject({ code: "invalid_github_path" });
  });

  it("stops at the page budget and reports remaining pages", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ id: 1 }]), {
      headers: { "content-type": "application/json", link: '<https://api.github.com/search/issues?page=2>; rel="next"' },
    }));
    const handler = createGitHubReadHandler({ tokenProvider: { getInstallationToken: async () => "secret" }, fetch });
    const result = await handler({ path: "/search/issues", query: { q: "repo:acme/widgets bug" }, pageBudget: 1 }, context("/tmp"));
    expect(result.pagination).toEqual({ pages: 1, hasMore: true, next: "https://api.github.com/search/issues?page=2" });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("page_limit");
  });

  it("stops reading a response stream as soon as the byte limit is exceeded", async () => {
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
    const handler = createGitHubReadHandler({
      tokenProvider: { getInstallationToken: async () => "secret" },
      fetch: vi.fn(async () => new Response(body, { headers: { "content-type": "application/octet-stream" } })),
      maxDecompressedBytes: 5,
    });

    await expect(handler({ path: "/repos/acme/widgets/actions/runs/1/logs" }, context("/tmp"))).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });
});
