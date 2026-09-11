import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinearIntegration } from "./client.js";
import type { TokenProvider } from "./token.js";

const h = vi.hoisted(() => ({
  builtWith: [] as string[],
  userFn: vi.fn(),
  issueFn: vi.fn(),
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

beforeEach(() => {
  h.builtWith.length = 0;
  h.userFn.mockReset();
  h.issueFn.mockReset();
  h.rawRequestFn.mockReset();
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
    const attachments = vi.fn()
      .mockResolvedValueOnce({
        nodes: [
          { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
          { id: "pr", title: "Pull request", url: "https://github.com/acme/repo/pull/1" },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      })
      .mockResolvedValueOnce({
        nodes: [{ id: "a2", title: "report.json", url: "https://uploads.linear.app/a2" }],
        pageInfo: { hasNextPage: false },
      });
    h.issueFn.mockResolvedValue({ attachments });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketAttachments("ABC-1")).resolves.toEqual([
      { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
      { id: "a2", title: "report.json", url: "https://uploads.linear.app/a2" },
    ]);
    expect(attachments).toHaveBeenNthCalledWith(2, { first: 100, after: "next" });
  });

  it("excludes malformed attachment URLs without dropping valid uploads", async () => {
    h.issueFn.mockResolvedValue({
      attachments: vi.fn().mockResolvedValue({
        nodes: [
          { id: "bad", title: "Malformed", url: "not a URL" },
          { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
        ],
        pageInfo: { hasNextPage: false },
      }),
    });
    const linear = new LinearIntegration({ tokenProvider: fakeProvider() });

    await expect(linear.getTicketAttachments("ABC-1")).resolves.toEqual([
      { id: "a1", title: "failure.log", url: "https://uploads.linear.app/a1" },
    ]);
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
