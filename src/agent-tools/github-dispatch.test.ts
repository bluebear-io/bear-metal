import { describe, expect, it, vi } from "vitest";
import { createGitHubDispatchHandler } from "./github-dispatch.js";

const policy = {
  repositories: ["acme/widgets"],
  workflows: ["release.yml", "12345"],
  refs: ["main", "refs/heads/release"],
};
const context = {
  taskId: "DEN-4082",
  runId: "run-1",
  workspaceRoot: "/tmp/workspace",
};

describe("github_dispatch", () => {
  it("uses the agent installation token for an allowed dispatch and returns a followable resource", async () => {
    const getInstallationToken = vi.fn(async () => "actions-token");
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = createGitHubDispatchHandler({ tokenProvider: { getInstallationToken }, policy, fetch });

    const result = await handler({ repository: "acme/widgets", workflow: "release.yml", ref: "main", inputs: { environment: "staging", dryRun: true, retries: 2 } }, context);

    expect(getInstallationToken).toHaveBeenCalledOnce();
    expect(getInstallationToken).toHaveBeenCalledWith();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/actions/workflows/release.yml/dispatches",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer actions-token" }),
        body: JSON.stringify({ ref: "main", inputs: { environment: "staging", dryRun: true, retries: 2 } }),
      }),
    );
    expect(result.data).toMatchObject({
      accepted: true,
      repository: "acme/widgets",
      workflow: "release.yml",
      ref: "main",
      followWith: "/repos/acme/widgets/actions/workflows/release.yml/runs",
    });
  });

  it("validates customer policy before minting a write token", async () => {
    const getInstallationToken = vi.fn(async () => "actions-token");
    const handler = createGitHubDispatchHandler({ tokenProvider: { getInstallationToken }, policy, fetch: vi.fn() });

    await expect(handler({ repository: "other/repo", workflow: "release.yml", ref: "main" }, context)).rejects.toMatchObject({ code: "dispatch_repository_denied" });
    await expect(handler({ repository: "acme/widgets", workflow: "unknown.yml", ref: "main" }, context)).rejects.toMatchObject({ code: "dispatch_workflow_denied" });
    await expect(handler({ repository: "acme/widgets", workflow: "release.yml", ref: "dev" }, context)).rejects.toMatchObject({ code: "dispatch_ref_denied" });
    expect(getInstallationToken).not.toHaveBeenCalled();
  });

  it("allows a configured repository outside the current task repository", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const handler = createGitHubDispatchHandler({ tokenProvider: { getInstallationToken: async () => "token" }, policy, fetch });
    const args = { repository: "acme/widgets", workflow: "release.yml", ref: "main" };

    await handler(args, context);
    await handler(args, context);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a discovered run id and URL when GitHub supplies them", async () => {
    const handler = createGitHubDispatchHandler({
      tokenProvider: { getInstallationToken: async () => "token" }, policy,
      fetch: vi.fn(async () => new Response(JSON.stringify({ id: 99, html_url: "https://github.com/acme/widgets/actions/runs/99" }), { status: 201, headers: { "content-type": "application/json" } })),
    });
    const result = await handler({ repository: "acme/widgets", workflow: "12345", ref: "main" }, context);
    expect(result.data).toMatchObject({ accepted: true, runId: 99, runUrl: "https://github.com/acme/widgets/actions/runs/99" });
  });

  it("redacts credential-shaped input fields from returned audit metadata", async () => {
    const handler = createGitHubDispatchHandler({
      tokenProvider: { getInstallationToken: async () => "token" }, policy,
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    });
    const result = await handler({ repository: "acme/widgets", workflow: "release.yml", ref: "main", inputs: { apiToken: "secret", version: "1.2.3" } }, context);
    expect(result.data).toMatchObject({ inputs: { apiToken: "[REDACTED]", version: "1.2.3" } });
  });
});
