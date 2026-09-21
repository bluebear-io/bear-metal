import { describe, expect, it, vi } from "vitest";
import { createAgentToolHandlers } from "./handlers.js";

const context = { taskId: "DEN-4082", runId: "run-1", workspaceRoot: "/workspace" };

describe("agent tool handler construction", () => {
  it("constructs only handlers backed by configured capabilities", async () => {
    const handlers = createAgentToolHandlers({
      github: { getInstallationToken: vi.fn(async () => "agent-github-token") },
      githubDispatchPolicy: { repositories: ["acme/widgets"], workflows: ["test.yml"], refs: ["main"] },
      web: {},
    });

    expect(Object.keys(handlers).sort()).toEqual(["github_dispatch", "github_read", "web_get"]);
    await expect(handlers.web_get!({ url: "https://127.0.0.1/" }, context)).rejects.toMatchObject({
      code: "unsafe_destination",
      provider: "web",
    });
  });

  it("constructs no handlers when no agent capabilities are configured", () => {
    expect(createAgentToolHandlers({})).toEqual({});
  });
});
