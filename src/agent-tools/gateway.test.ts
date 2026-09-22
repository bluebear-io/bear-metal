import { describe, expect, it, vi } from "vitest";
import { AgentToolGateway } from "./gateway.js";
import type { AgentToolHandlers, AgentToolResponse } from "./types.js";

const response: AgentToolResponse = {
  source: { provider: "github", resource: "/repos/acme/widgets" },
  data: { name: "widgets" },
  pagination: { pages: 1, hasMore: false },
  bytes: { compressed: 18, decompressed: 18, returned: 18 },
  truncated: false,
};

describe("AgentToolGateway", () => {
  it("routes requests and emits credential-safe audit metadata", async () => {
    const handler = vi.fn(async () => response);
    const onAudit = vi.fn();
    const gateway = new AgentToolGateway({ handlers: handlers(handler), onAudit });
    expect(gateway.availableTools()).toEqual(["github_read"]);

    await expect(gateway.execute(
      { tool: "github_read", arguments: { path: "/repos/acme/widgets", token: "secret" } },
      { taskId: "DEN-1", runId: "run-1", workspaceRoot: "/workspace" },
    )).resolves.toEqual(response);

    expect(handler).toHaveBeenCalledWith(
      { path: "/repos/acme/widgets", token: "secret" },
      { taskId: "DEN-1", runId: "run-1", workspaceRoot: "/workspace" },
    );
    expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "DEN-1",
      runId: "run-1",
      tool: "github_read",
      resource: "/repos/acme/widgets",
      arguments: { path: "/repos/acme/widgets", token: "[REDACTED]" },
      status: "ok",
      bytes: response.bytes,
      pages: 1,
      truncated: false,
    }));
  });

  it("normalizes handler errors without leaking credentials", async () => {
    const onAudit = vi.fn();
    const gateway = new AgentToolGateway({
      handlers: handlers(async () => { throw new Error("Authorization: Bearer secret"); }),
      onAudit,
    });

    await expect(gateway.execute(
      { tool: "github_read", arguments: { path: "/repos/acme/widgets" } },
      { taskId: "DEN-1", runId: "run-1", workspaceRoot: "/workspace" },
    )).rejects.toMatchObject({ code: "provider_error", message: "Authorization: [REDACTED]" });
    expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({ status: "error", bytes: null, pages: 0 }));
  });

  it("redacts credential-bearing provider data and source URLs before returning them", async () => {
    const gateway = new AgentToolGateway({
      handlers: handlers(async () => ({
        ...response,
        source: { provider: "github", resource: "https://example.com/file?X-Amz-Signature=secret" },
        data: { access_token: "secret", url: "https://example.com/file?token=secret" },
      })),
    });

    await expect(gateway.execute(
      { tool: "github_read", arguments: {} },
      { taskId: "DEN-1", runId: "run-1", workspaceRoot: "/workspace" },
    )).resolves.toMatchObject({
      source: { resource: "https://example.com/file?X-Amz-Signature=%5BREDACTED%5D" },
      data: { access_token: "[REDACTED]", url: "https://example.com/file?token=%5BREDACTED%5D" },
    });
  });
});

function handlers(githubRead: AgentToolHandlers["github_read"]): AgentToolHandlers {
  return { github_read: githubRead };
}
