import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinearIntegration } from "./client.js";
import type { TokenProvider } from "./token.js";

const h = vi.hoisted(() => ({
  builtWith: [] as string[],
  userFn: vi.fn(),
  issueFn: vi.fn(),
  AuthErr: class AuthenticationLinearError extends Error {},
}));

vi.mock("@linear/sdk", () => {
  class LinearClient {
    private readonly accessToken: string;
    constructor(opts: { accessToken: string }) {
      this.accessToken = opts.accessToken;
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

beforeEach(() => {
  h.builtWith.length = 0;
  h.userFn.mockReset();
  h.issueFn.mockReset();
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
