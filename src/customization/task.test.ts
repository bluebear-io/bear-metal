import { describe, expect, it, vi } from "vitest";
import { buildTask, customizeAndResolve } from "./task.js";
import type { BearMetalConfig } from "./types.js";

describe("task customization", () => {
  it("builds an immutable provider-neutral task", () => {
    const task = buildTask({ state: "new", iteration: 1, attachments: [], prs: [], pullRequests: [], ticket: { issue: { id: "id", identifier: "DEN-1", title: "Title", description: null, url: "https://linear.app/DEN-1", branchName: "branch", status: { name: "Todo", type: "unstarted" }, priority: 2, labels: ["a"], teamKey: "DEN", assignee: null, delegate: null }, comments: [{ id: "comment", body: "body", url: "url", createdAt: "created", updatedAt: "updated", user: { id: "user", name: "User", email: "user@example.com" } }] } });
    expect(task).toMatchObject({ identifier: "DEN-1", priority: "high", status: { category: "unstarted" }, run: { kind: "new", iteration: 1 } });
    expect(Object.isFrozen(task)).toBe(true); expect(Object.isFrozen(task.labels)).toBe(true);
    expect(task.comments[0]).toEqual({ id: "comment", body: "body", url: "url", createdAt: "created", updatedAt: "updated", author: { id: "user", name: "User", email: "user@example.com" } });
    expect(task.comments[0]).not.toHaveProperty("user");
  });
  it("normalizes triage and rejects unknown tracker status categories", () => {
    const input = { state: "new" as const, iteration: 1, attachments: [], prs: [], pullRequests: [], ticket: { issue: { id: "id", identifier: "DEN-1", title: "Title", description: null, url: "url", branchName: "branch", status: { name: "Triage", type: "triage" }, priority: 0, labels: [], teamKey: "DEN", assignee: null, delegate: null }, comments: [] } };
    expect(buildTask(input).status.category).toBe("backlog");
    input.ticket.issue.status.type = "unexpected";
    expect(() => buildTask(input)).toThrow("Unsupported task status category");
  });
  it("maps only supported priorities and rejects invalid tracker values", () => {
    const input = { state: "new" as const, iteration: 1, attachments: [], prs: [], pullRequests: [], ticket: { issue: { id: "id", identifier: "DEN-1", title: "Title", description: null, url: "url", branchName: "branch", status: { name: "Todo", type: "unstarted" }, priority: 0, labels: [], teamKey: "DEN", assignee: null, delegate: null }, comments: [] } };
    expect(buildTask(input).priority).toBe("none");
    input.ticket.issue.priority = 4;
    expect(buildTask(input).priority).toBe("low");
    for (const invalid of [-1, 5, 1.5, Number.NaN]) {
      input.ticket.issue.priority = invalid;
      expect(() => buildTask(input)).toThrow("Unsupported task priority");
    }
  });
  it("maps PRs without provider-only fields and preserves timestamps", () => {
    const task = buildTask({ state: "iteration", iteration: 2, attachments: [], prs: [{ owner: "org", repo: "repo", number: 3 }], ticket: { issue: { id: "id", identifier: "DEN-1", title: "Title", description: null, url: "url", branchName: "branch", status: { name: "Started", type: "started" }, priority: 0, labels: [], teamKey: "DEN", assignee: null, delegate: null }, comments: [] }, pullRequests: [{ pullRequest: { title: "PR", html_url: "https://github/pr/3", state: "open", draft: false, merged: false, head: { ref: "branch" }, created_at: "created", updated_at: "updated", merged_at: null, closed_at: null }, headSha: "sha", failedCheckRuns: [], failedStatuses: [], checksInProgress: false, unresolvedReviewThreads: [], reviewThreads: [], issueComments: [{ id: "comment", databaseId: 12, body: "body", author: "author", authorId: "provider-id", isMinimized: false, createdAt: "created", updatedAt: "updated" }], completedIssueComments: [], mergeable: true }] });
    expect(task.pullRequests[0]).toMatchObject({ createdAt: "created", updatedAt: "updated", mergedAt: null, closedAt: null });
    expect(task.pullRequests[0]!.comments[0]).toEqual({ id: "comment", body: "body", author: "author", url: null, createdAt: "created", updatedAt: "updated" });
    expect(task.pullRequests[0]!.comments[0]).not.toHaveProperty("databaseId"); expect(task.pullRequests[0]!.comments[0]).not.toHaveProperty("authorId"); expect(task.pullRequests[0]!.comments[0]).not.toHaveProperty("isMinimized");
  });
  it("resolves only the selected provider", async () => {
    const anthropic = vi.fn(() => "anthropic-secret"); const openai = vi.fn(() => "openai-secret");
    const config = { llmProviders: { anthropic: { getApiKey: anthropic }, openai: { getApiKey: openai } }, customizeTask: () => ({ llm: { provider: "openai", model: "gpt" }, async buildWorkspace() {} }) } as unknown as BearMetalConfig;
    const result = await customizeAndResolve(config, {} as never);
    expect(result.llm).toEqual({ provider: "openai", model: "gpt", apiKey: "openai-secret" }); expect(anthropic).not.toHaveBeenCalled();
  });
  it("uses ambient credentials for Bedrock without a registry entry", async () => {
    const config = { llmProviders: {}, customizeTask: () => ({ llm: { provider: "amazon-bedrock", model: "model" }, async buildWorkspace() {} }) } as unknown as BearMetalConfig;
    await expect(customizeAndResolve(config, {} as never)).resolves.toMatchObject({ llm: { provider: "amazon-bedrock", model: "model", apiKey: null } });
  });
  it("explains that key-based providers need a credential getter", async () => {
    const config = { llmProviders: {}, customizeTask: () => ({ llm: { provider: "openai", model: "model" }, async buildWorkspace() {} }) } as unknown as BearMetalConfig;
    await expect(customizeAndResolve(config, {} as never)).rejects.toThrow("Add llmProviders.openai: { getApiKey: () => ... }");
  });
});
