import { describe, expect, it, vi } from "vitest";
import { createLinearReadHandler, type LinearGraphqlRequest } from "./linear-read.js";

const context = { taskId: "DEN-4082", runId: "run-1", workspaceRoot: "/workspace" };

describe("linear_read", () => {
  it("executes a named read query with the independent token and preserves partial errors", async () => {
    const execute = vi.fn(async (_request: LinearGraphqlRequest) => ({
      status: 200,
      body: JSON.stringify({ data: { issue: { identifier: "DEN-4082" } }, errors: [{ message: "comment unavailable" }] }),
    }));
    const tokenProvider = provider("agent-linear-token");
    const handler = createLinearReadHandler({ tokenProvider, execute });

    const response = await handler({
      query: "query ReadIssue($id: String!) { issue(id: $id) { identifier comments(first: 2) { nodes { body } } } }",
      variables: { id: "DEN-4082" },
      operationName: "ReadIssue",
    }, context);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      token: "agent-linear-token",
      variables: { id: "DEN-4082" },
      operationName: "ReadIssue",
    }));
    expect(response.data).toEqual({ issue: { identifier: "DEN-4082" } });
    expect(response.errors).toEqual([{ message: "comment unavailable" }]);
    expect(response.source).toEqual({ provider: "linear", resource: "graphql:ReadIssue" });
    expect(response.pagination).toEqual({ pages: 1, hasMore: false });
    expect(response.truncated).toBe(false);
  });

  it.each([
    ["mutation", "mutation Rename { issueUpdate(id: \"x\", input: {}) { success } }", "read_only_query_required"],
    ["subscription", "subscription Changes { issueChanged { id } }", "read_only_query_required"],
    ["mixed operations", "query Read { viewer { id } } mutation Write { issueDelete(id: \"x\") { success } }", "read_only_query_required"],
    ["introspection", "query Schema { __schema { queryType { name } } }", "introspection_forbidden"],
  ])("rejects %s documents before obtaining a token", async (_name, query, code) => {
    const tokenProvider = provider("secret");
    const handler = createLinearReadHandler({ tokenProvider, execute: vi.fn() });
    await expect(handler({ query }, context)).rejects.toMatchObject({ code });
    expect(tokenProvider.getToken).not.toHaveBeenCalled();
  });

  it("requires operationName for multiple queries and selects an existing operation", async () => {
    const handler = createLinearReadHandler({ tokenProvider: provider("token"), execute: vi.fn() });
    const query = "query One { viewer { id } } query Two { teams(first: 1) { nodes { id } } }";
    await expect(handler({ query }, context)).rejects.toMatchObject({ code: "operation_name_required" });
    await expect(handler({ query, operationName: "Missing" }, context)).rejects.toMatchObject({ code: "unknown_operation" });
  });

  it("enforces depth, expanded fields, aliases, fragments, variables, and pagination bounds", async () => {
    const base = { tokenProvider: provider("token"), execute: vi.fn() };
    await expect(createLinearReadHandler({ ...base, maxDepth: 2 })({ query: "query { viewer { organization { id } } }" }, context))
      .rejects.toMatchObject({ code: "query_depth_exceeded" });
    await expect(createLinearReadHandler({ ...base, maxFields: 2 })({ query: "query { viewer { id name } }" }, context))
      .rejects.toMatchObject({ code: "query_fields_exceeded" });
    await expect(createLinearReadHandler({ ...base, maxAliases: 1 })({ query: "query { a: viewer { id } b: viewer { id } }" }, context))
      .rejects.toMatchObject({ code: "query_aliases_exceeded" });
    await expect(createLinearReadHandler({ ...base, maxFragments: 1 })({
      query: "query { viewer { ...A } } fragment A on User { ...B } fragment B on User { id }",
    }, context)).rejects.toMatchObject({ code: "query_fragments_exceeded" });
    await expect(createLinearReadHandler({ ...base, maxVariableBytes: 4 })({ query: "query($id: String!) { issue(id: $id) { id } }", variables: { id: "large" } }, context))
      .rejects.toMatchObject({ code: "variables_too_large" });
    await expect(createLinearReadHandler({ ...base, maxPageSize: 50 })({ query: "query { issues(first: 51) { nodes { id } } }" }, context))
      .rejects.toMatchObject({ code: "pagination_limit_exceeded" });
    await expect(createLinearReadHandler({ ...base, maxPaginationItems: 5 })({
      query: "query($count: Int!) { issues(first: $count) { nodes { id } } }", variables: { count: 6 },
    }, context)).rejects.toMatchObject({ code: "pagination_budget_exceeded" });
  });

  it("rejects cyclic and undefined fragments", async () => {
    const handler = createLinearReadHandler({ tokenProvider: provider("token"), execute: vi.fn() });
    await expect(handler({ query: "query { viewer { ...A } } fragment A on User { ...A }" }, context))
      .rejects.toMatchObject({ code: "fragment_cycle" });
    await expect(handler({ query: "query { viewer { ...Missing } }" }, context))
      .rejects.toMatchObject({ code: "undefined_fragment" });
  });

  it("bounds response bytes and duration", async () => {
    const oversized = createLinearReadHandler({
      tokenProvider: provider("token"), maxResponseBytes: 10,
      execute: async () => ({ status: 200, body: JSON.stringify({ data: { value: "too large" } }) }),
    });
    await expect(oversized({ query: "query { viewer { id } }" }, context)).rejects.toMatchObject({ code: "response_too_large" });

    const slow = createLinearReadHandler({
      tokenProvider: provider("token"), timeoutMs: 10,
      execute: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });
    await expect(slow({ query: "query { viewer { id } }" }, context)).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("invalidates and retries once after an authentication failure", async () => {
    const tokenProvider = provider("refreshed-token");
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 401, body: "unauthorized" })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ data: { viewer: { id: "user" } } }) });
    const handler = createLinearReadHandler({ tokenProvider, execute });
    await expect(handler({ query: "query { viewer { id } }" }, context)).resolves.toMatchObject({ data: { viewer: { id: "user" } } });
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function provider(token: string) {
  return { getToken: vi.fn(async () => token), invalidate: vi.fn() };
}
