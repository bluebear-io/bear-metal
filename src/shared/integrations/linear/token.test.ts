import { describe, expect, it, vi } from "vitest";

import { AppTokenProvider } from "./token.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tokenResponse(accessToken: string, expiresIn = 30 * 24 * 60 * 60): Response {
  return new Response(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeProvider(fetchFn: typeof fetch, now: () => number) {
  return new AppTokenProvider({
    clientId: "cid",
    clientSecret: "secret",
    scopes: "read,write",
    tokenEndpoint: "https://token.test/oauth/token",
    fetchFn,
    now,
  });
}

describe("AppTokenProvider", () => {
  it("mints a token on first call and posts client_credentials form fields", async () => {
    const fetchFn = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(tokenResponse("tok-1")),
    );
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => 0);

    expect(await provider.getToken()).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://token.test/oauth/token");
    expect(init?.method).toBe("POST");
    const body = (init?.body as URLSearchParams).toString();
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=secret");
    expect(body).toContain("scope=read%2Cwrite");
  });

  it("caches the token within its lifetime (no re-mint)", async () => {
    const fetchFn = vi.fn(async () => tokenResponse("tok-1"));
    let now = 0;
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => now);

    await provider.getToken();
    now = 5 * DAY; // well within 30d, outside the 24h refresh window
    expect(await provider.getToken()).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-mints inside the 24h refresh window before expiry", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1"))
      .mockResolvedValueOnce(tokenResponse("tok-2"));
    let now = 0;
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => now);

    expect(await provider.getToken()).toBe("tok-1"); // expiresAt = 30d
    now = 30 * DAY - 12 * HOUR; // inside the final 24h window
    expect(await provider.getToken()).toBe("tok-2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("re-mints after invalidate()", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1"))
      .mockResolvedValueOnce(tokenResponse("tok-2"));
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => 0);

    expect(await provider.getToken()).toBe("tok-1");
    provider.invalidate();
    expect(await provider.getToken()).toBe("tok-2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent mints into a single request", async () => {
    const fetchFn = vi.fn(async () => tokenResponse("tok-1"));
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => 0);

    const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx response", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }));
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => 0);

    await expect(provider.getToken()).rejects.toThrow(/401/);
  });

  it("throws on a malformed response missing access_token/expires_in", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    );
    const provider = makeProvider(fetchFn as unknown as typeof fetch, () => 0);

    await expect(provider.getToken()).rejects.toThrow(/missing access_token or expires_in/);
  });
});
