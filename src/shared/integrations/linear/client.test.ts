import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinearIntegration } from "./client.js";
import type { TokenProvider } from "./token.js";

const h = vi.hoisted(() => ({
  builtWith: [] as string[],
  userFn: vi.fn(),
  issueFn: vi.fn(),
  createIssueFn: vi.fn(),
  usersFn: vi.fn(),
  teamsFn: vi.fn(),
  projectsFn: vi.fn(),
  cyclesFn: vi.fn(),
  workflowStatesFn: vi.fn(),
  rawRequestFn: vi.fn(),
  AuthErr: class AuthenticationLinearError extends Error {},
}));

vi.mock("@linear/sdk", () => {
  class LinearClient {
    private readonly accessToken: string;
    readonly client: { rawRequest: (query: string, variables: Record<string, unknown>) => unknown };
    constructor(opts: { accessToken: string }) {
      this.accessToken = opts.accessToken;
      this.client = {
        rawRequest: (query, variables) => h.rawRequestFn(this.accessToken, query, variables),
      };
      h.builtWith.push(opts.accessToken);
    }
    user(id: string) {
      return h.userFn(this.accessToken, id);
    }
    issue(id: string) {
      return h.issueFn(this.accessToken, id);
    }
    createIssue(input: Record<string, unknown>) {
      return h.createIssueFn(this.accessToken, input);
    }
    users(input: Record<string, unknown>) {
      return h.usersFn(this.accessToken, input);
    }
    teams(input: Record<string, unknown>) { return h.teamsFn(this.accessToken, input); }
    projects(input: Record<string, unknown>) { return h.projectsFn(this.accessToken, input); }
    cycles(input: Record<string, unknown>) { return h.cyclesFn(this.accessToken, input); }
    workflowStates(input: Record<string, unknown>) {
      return h.workflowStatesFn(this.accessToken, input);
    }
  }
  return { LinearClient, AuthenticationLinearError: h.AuthErr };
});

function fakeProvider(overrides: Partial<TokenProvider> = {}): TokenProvider {
  return {
    getToken: vi.fn(async () => "tok"),
    invalidate: vi.fn(),
    ...overrides,
  };
}

function validRawIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "DEN-1",
    title: "Ticket",
    description: "Description",
    url: "https://linear.app/issue/DEN-1",
    branchName: "fix/den-1/ticket",
    state: { name: "In Progress", type: "started" },
    labels: { nodes: [{ name: "Bug" }] },
    team: { key: "DEN" },
    priority: 2,
    assignee: { id: "user-1" },
    delegate: { id: "agent-1" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    ...overrides,
  };
}

function validRawContextIssue(overrides: Record<string, unknown> = {}) {
  return {
    ...validRawIssue(),
    assignee: { id: "user-1", name: "User", email: "user@example.com" },
    project: { id: "project-1", name: "Project" },
    relations: {
      nodes: [{ id: "relation-1", type: "blocks", relatedIssue: { identifier: "DEN-2" } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    inverseRelations: {
      nodes: [{ id: "relation-2", type: "blockedBy", relatedIssue: { identifier: "DEN-3" } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    comments: {
      nodes: [{ id: "comment-1", body: "First", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z", url: "https://linear.app/comment/1", user: { id: "user-1", name: "User", email: "user@example.com" } }],
      pageInfo: { hasNextPage: true, endCursor: "comments-next" },
    },
    attachments: {
      nodes: [{ id: "attachment-1", title: "First", url: "https://uploads.linear.app/first" }],
      pageInfo: { hasNextPage: true, endCursor: "attachments-next" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  h.builtWith.length = 0;
  h.userFn.mockReset();
  h.issueFn.mockReset();
  h.createIssueFn.mockReset();
  h.usersFn.mockReset();
  h.teamsFn.mockReset();
  h.projectsFn.mockReset();
  h.cyclesFn.mockReset();
  h.workflowStatesFn.mockReset();
  h.rawRequestFn.mockReset();
});

describe("LinearIntegration Slack ticket creation", () => {
  it("returns paginated cycles with their owning teams for destination lookup", async () => {
    h.teamsFn.mockResolvedValue({ nodes: [{ id: "team-1", key: "DEN", name: "Engineering" }], pageInfo: { hasNextPage: false } });
    h.projectsFn.mockResolvedValue({ nodes: [], pageInfo: { hasNextPage: false } });
    const cycle = (id: string, number: number) => ({ id, number, name: null, startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-10-15T00:00:00Z"), team: Promise.resolve({ id: "team-1" }) });
    h.cyclesFn.mockResolvedValueOnce({ nodes: [cycle("cycle-1", 1)], pageInfo: { hasNextPage: true, endCursor: "cycles-next" } })
      .mockResolvedValueOnce({ nodes: [cycle("cycle-2", 2)], pageInfo: { hasNextPage: false } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });
    const result = await linear.listSlackTicketDestinations();
    expect(result).toMatchObject({ cycles: [
      { id: "cycle-1", teamId: "team-1", name: null, number: 1, startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z" },
      { id: "cycle-2", teamId: "team-1", name: null, number: 2 },
    ] });
    expect(h.cyclesFn).toHaveBeenLastCalledWith("tok", { first: 100, after: "cycles-next" });
  });

  it("finds the exact Linear assignee by Slack email", async () => {
    h.usersFn.mockResolvedValue({ nodes: [{ id: "user-1", email: "user@example.com" }], pageInfo: { hasNextPage: false } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });
    await expect(linear.findUserIdByEmail("user@example.com")).resolves.toBe("user-1");
    expect(h.usersFn).toHaveBeenCalledWith("tok", { filter: { email: { eq: "user@example.com" } }, first: 2 });
  });
  it("assigns a newly created ticket", async () => {
    h.createIssueFn.mockResolvedValue({ success: true, issue: Promise.resolve({ id: "issue-1", url: "https://linear.app/issue/DEN-1", identifier: "DEN-1" }) });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });
    await linear.createSlackCodingTicket({ teamId: "team-1", title: "Title", description: "Description", assigneeId: "user-1" });
    expect(h.createIssueFn).toHaveBeenCalledWith("tok", expect.objectContaining({ assigneeId: "user-1" }));
  });
  it("removes delegation while canceling the ticket", async () => {
    const update = vi.fn(async () => ({ success: true }));
    h.issueFn.mockResolvedValue({ team: Promise.resolve({ id: "team-1" }), update });
    h.workflowStatesFn.mockResolvedValue({ nodes: [
      { id: "wont-do", teamId: "team-1", type: "canceled", name: "Won't Do" },
      { id: "canceled-1", teamId: "team-1", type: "canceled", name: "Canceled" },
      { id: "duplicate", teamId: "team-1", type: "canceled", name: "Duplicate" },
    ] });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });
    await linear.cancelSlackCodingTicket("issue-1");
    expect(update).toHaveBeenCalledWith({ stateId: "canceled-1", delegateId: null });
  });
  it("omits projectId when creating a team ticket without a project", async () => {
    h.createIssueFn.mockResolvedValue({ success: true, issue: Promise.resolve({ id: "issue-1", url: "https://linear.app/issue/DEN-1", identifier: "DEN-1" }) });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });
    await linear.createSlackCodingTicket({ teamId: "team-1", title: "Title", description: "Description" });
    expect(h.createIssueFn).toHaveBeenCalledWith("tok", { teamId: "team-1", title: "Title", description: "Description" });
  });
});

describe("LinearIntegration getTicket", () => {
  it("retrieves the complete ticket in exactly one Linear request", async () => {
    h.rawRequestFn.mockResolvedValue({
      data: {
        issue: validRawIssue(),
      },
    });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).resolves.toEqual({
      id: "issue-1",
      identifier: "DEN-1",
      title: "Ticket",
      description: "Description",
      url: "https://linear.app/issue/DEN-1",
      branchName: "fix/den-1/ticket",
      status: { name: "In Progress", type: "started" },
      priority: 2,
      labels: ["Bug"],
      teamKey: "DEN",
      assignee: { id: "user-1" },
      delegate: { id: "agent-1" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      completedAt: null,
      canceledAt: null,
    });
    expect(h.issueFn).not.toHaveBeenCalled();
    expect(h.rawRequestFn).toHaveBeenCalledTimes(1);
    expect(h.rawRequestFn).toHaveBeenCalledWith("tok", expect.stringContaining("labels { nodes { name } }"), {
      id: "DEN-1",
    });
  });

  it("throws when Linear returns no data", async () => {
    h.rawRequestFn.mockResolvedValue({ data: undefined });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).rejects.toThrow("Linear returned no data for issue DEN-1");
  });

  it("throws a descriptive error when the issue is not found", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: null } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).rejects.toThrow("Linear issue DEN-1 not found");
  });

  it("throws when the issue has no workflow state", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: validRawIssue({ state: null }) } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).rejects.toThrow("Linear issue DEN-1 has no workflow state");
  });

  it("throws when the issue has no team", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: validRawIssue({ team: null }) } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).rejects.toThrow("Linear issue DEN-1 has no team");
  });

  it("invalidates the token and retries once when the raw request is unauthenticated", async () => {
    const provider = fakeProvider();
    h.rawRequestFn
      .mockRejectedValueOnce(new h.AuthErr("not authenticated"))
      .mockResolvedValueOnce({ data: { issue: validRawIssue() } });
    const linear = new LinearIntegration({ tokenProvider: provider });

    await expect(linear.getTicket("DEN-1")).resolves.toMatchObject({ id: "issue-1" });
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(h.rawRequestFn).toHaveBeenCalledTimes(2);
  });

  it("preserves the no-priority fallback used by other ticket reads", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: validRawIssue({ priority: null }) } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicket("DEN-1")).resolves.toMatchObject({ priority: 0 });
  });
});

describe("LinearIntegration attachments", () => {
  it("paginates uploaded Linear assets and excludes external integration links", async () => {
    h.rawRequestFn
      .mockResolvedValueOnce({ data: { issue: { attachments: { nodes: [
        { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
        { id: "pr", title: "Pull request", url: "https://github.com/acme/repo/pull/1" },
      ], pageInfo: { hasNextPage: true, endCursor: "next" } } } } })
      .mockResolvedValueOnce({ data: { issue: { attachments: { nodes: [
        { id: "a2", title: "report.json", url: "https://uploads.linear.app/a2" },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketAttachments("ABC-1")).resolves.toEqual([
      { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
      { id: "a2", title: "report.json", url: "https://uploads.linear.app/a2" },
    ]);
    expect(h.issueFn).not.toHaveBeenCalled();
    expect(h.rawRequestFn).toHaveBeenNthCalledWith(2, "tok", expect.stringContaining("attachments(first: 100, after: $after)"), { id: "ABC-1", after: "next" });
  });

  it("excludes malformed attachment URLs without dropping valid uploads", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: { attachments: {
      nodes: [
          { id: "bad", title: "Malformed", url: "not a URL" },
          { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
        ],
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketAttachments("ABC-1")).resolves.toEqual([
      { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
    ]);
  });
});

describe("LinearIntegration ticket context", () => {
  it("uses app-actor-safe raw queries and paginates comments and attachments", async () => {
    h.rawRequestFn
      .mockResolvedValueOnce({ data: { issue: validRawContextIssue() } })
      .mockResolvedValueOnce({ data: { issue: { comments: { nodes: [
        { id: "comment-2", body: "Second", createdAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-06T00:00:00.000Z", url: "https://linear.app/comment/2", user: null },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } })
      .mockResolvedValueOnce({ data: { issue: { attachments: { nodes: [
        { id: "attachment-2", title: "Second", url: "https://example.com/second" },
      ], pageInfo: { hasNextPage: false, endCursor: null } } } } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketContext("DEN-1")).resolves.toEqual({
      issue: expect.objectContaining({
        id: "issue-1",
        project: { id: "project-1", name: "Project" },
        assignee: { id: "user-1", name: "User", email: "user@example.com" },
        relations: [
          { type: "blocks", taskIdentifier: "DEN-2" },
          { type: "blockedBy", taskIdentifier: "DEN-3" },
        ],
      }),
      comments: [
        { id: "comment-1", body: "First", createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z", url: "https://linear.app/comment/1", user: { id: "user-1", name: "User", email: "user@example.com" } },
        { id: "comment-2", body: "Second", createdAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-06T00:00:00.000Z", url: "https://linear.app/comment/2", user: null },
      ],
      attachments: [
        { id: "attachment-1", title: "First", url: "https://uploads.linear.app/first" },
        { id: "attachment-2", title: "Second", url: "https://example.com/second" },
      ],
    });
    expect(h.issueFn).not.toHaveBeenCalled();
    expect(h.rawRequestFn).toHaveBeenCalledTimes(3);
    expect(h.rawRequestFn).toHaveBeenNthCalledWith(2, "tok", expect.stringContaining("comments(first: 100, after: $after)"), { id: "DEN-1", after: "comments-next" });
    expect(h.rawRequestFn).toHaveBeenNthCalledWith(3, "tok", expect.stringContaining("attachments(first: 100, after: $after)"), { id: "DEN-1", after: "attachments-next" });
  });

  it("fails fast when a relation has no related issue", async () => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: validRawContextIssue({
      relations: { nodes: [{ id: "relation-broken", type: "blocks", relatedIssue: null }], pageInfo: { hasNextPage: false, endCursor: null } },
      comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }) } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketContext("DEN-1")).rejects.toThrow("Linear relation relation-broken has no related issue");
  });

  it.each([
    ["workflow state", { state: null }, "Linear issue DEN-1 has no workflow state"],
    ["team", { team: null }, "Linear issue DEN-1 has no team"],
  ])("fails fast when the issue has no %s", async (_field, override, message) => {
    h.rawRequestFn.mockResolvedValue({ data: { issue: validRawContextIssue({
      ...override,
      comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }) } });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketContext("DEN-1")).rejects.toThrow(message);
  });

  it("invalidates the token and retries the raw context query after an authentication error", async () => {
    const provider = fakeProvider();
    h.rawRequestFn
      .mockRejectedValueOnce(new h.AuthErr("not authenticated"))
      .mockResolvedValueOnce({ data: { issue: validRawContextIssue({
        comments: { nodes: [
          { id: "comment-retry", body: "Retry", createdAt: "2026-01-07T00:00:00.000Z", updatedAt: "2026-01-08T00:00:00.000Z", url: "https://linear.app/comment/retry", user: null },
        ], pageInfo: { hasNextPage: false, endCursor: null } },
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }) } });
    const linear = new LinearIntegration({ tokenProvider: provider });

    await expect(linear.getTicketContext("DEN-1")).resolves.toMatchObject({
      issue: { id: "issue-1" },
      comments: [{ id: "comment-retry" }],
      attachments: [],
    });
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(h.rawRequestFn).toHaveBeenCalledTimes(2);
  });

  it("restarts context pagination after an authentication error on a later page", async () => {
    const provider = fakeProvider();
    h.rawRequestFn
      .mockResolvedValueOnce({ data: { issue: validRawContextIssue({
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }) } })
      .mockRejectedValueOnce(new h.AuthErr("not authenticated"))
      .mockResolvedValueOnce({ data: { issue: validRawContextIssue({
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        attachments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }) } });
    const linear = new LinearIntegration({ tokenProvider: provider });

    await expect(linear.getTicketContext("DEN-1")).resolves.toMatchObject({ issue: { id: "issue-1" } });
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(h.rawRequestFn).toHaveBeenCalledTimes(3);
    expect(h.rawRequestFn).toHaveBeenNthCalledWith(2, "tok", expect.stringContaining("comments(first: 100, after: $after)"), {
      id: "DEN-1",
      after: "comments-next",
    });
    expect(h.rawRequestFn).toHaveBeenNthCalledWith(3, "tok", expect.stringContaining("query GetTicketContext"), {
      id: "DEN-1",
    });
  });
});

describe("LinearIntegration token handling", () => {
  it("rebuilds the underlying client only when the token rotates", async () => {
    const getToken = vi.fn().mockResolvedValueOnce("t1").mockResolvedValueOnce("t2").mockResolvedValue("t2");
    h.userFn.mockResolvedValue({ email: "a@b.com" });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider({ getToken }) });

    await linear.getUserEmail("u1");
    await linear.getUserEmail("u1"); // token rotated to t2 → rebuild
    await linear.getUserEmail("u1"); // token still t2 → reuse

    expect(h.builtWith).toEqual(["t1", "t2"]);
  });

  it("invalidates the token and retries once on an authentication error", async () => {
    const provider = fakeProvider();
    h.userFn.mockRejectedValueOnce(new h.AuthErr("not authenticated")).mockResolvedValueOnce({ email: "ok@b.com" });
    const linear = new LinearIntegration({ tokenProvider: provider });

    expect(await linear.getUserEmail("u1")).toBe("ok@b.com");
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(h.userFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry or invalidate on a non-auth error", async () => {
    const provider = fakeProvider();
    h.userFn.mockRejectedValue(new Error("boom"));
    const linear = new LinearIntegration({ tokenProvider: provider });

    await expect(linear.getUserEmail("u1")).rejects.toThrow("boom");
    expect(provider.invalidate).not.toHaveBeenCalled();
    expect(h.userFn).toHaveBeenCalledTimes(1);
  });
});
