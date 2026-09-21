import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToolError } from "./types.js";
import { createWebGetHandler, isPublicAddress, type WebGetRequest } from "./web-get.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const context = (workspaceRoot = "/workspace") => ({ taskId: "DEN-4082", runId: "run-1", workspaceRoot });
const response = (overrides: Partial<Awaited<ReturnType<WebGetRequest>>> = {}) => ({
  status: 200,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: Buffer.from("hello"),
  compressedBytes: 5,
  connectedAddress: "93.184.216.34",
  ...overrides,
});

describe("createWebGetHandler", () => {
  it("resolves a public destination and pins the connection to it", async () => {
    const request = vi.fn(async () => response());
    const handler = createWebGetHandler({
      resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }] as const),
      request,
    });

    const result = await handler({ url: "https://example.com/file", responseFormat: "text" }, context());

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL("https://example.com/file"),
      address: "93.184.216.34",
      family: 4,
      headers: expect.objectContaining({ "user-agent": "Bear-Metal-Agent/1.0", accept: "text/plain, application/json;q=0.9, */*;q=0.1" }),
    }));
    expect(result).toMatchObject({ data: "hello", source: { provider: "web" }, bytes: { compressed: 5, decompressed: 5, returned: 5 } });
  });

  it.each([
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "224.0.0.1", "192.0.2.1", "0.0.0.0",
    "::1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
  ])("rejects non-public address %s", async (address) => {
    const request = vi.fn();
    const handler = createWebGetHandler({ resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }], request });
    await expect(handler({ url: "https://example.com" }, context())).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unsafe URL forms, ports, schemes, and HTTP unless explicitly enabled", async () => {
    const handler = createWebGetHandler({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], request: async () => response() });
    for (const url of ["https://user:pass@example.com", "https://example.com:8443", "file:///etc/passwd", "http://example.com"]) {
      await expect(handler({ url }, context())).rejects.toBeInstanceOf(AgentToolError);
    }
    const httpHandler = createWebGetHandler({ allowHttp: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], request: async () => response() });
    await expect(httpHandler({ url: "http://example.com" }, context())).resolves.toMatchObject({ data: "hello" });
  });

  it("re-resolves and revalidates every redirect without forwarding URL credentials", async () => {
    const resolve = vi.fn(async (hostname: string) => [{ address: hostname === "one.example" ? "93.184.216.34" : "93.184.216.35", family: 4 as const }]);
    const request = vi.fn()
      .mockResolvedValueOnce(response({ status: 302, headers: { location: "https://two.example/final" }, body: Buffer.alloc(0), compressedBytes: 0 }))
      .mockResolvedValueOnce(response({ body: Buffer.from('{"ok":true}'), compressedBytes: 11, headers: { "content-type": "application/json" }, connectedAddress: "93.184.216.35" }));
    const handler = createWebGetHandler({ resolve, request });

    const result = await handler({ url: "https://one.example/start", responseFormat: "json" }, context());

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({ address: "93.184.216.35" }));
    expect(result.data).toEqual({ ok: true });
    expect(result.source.resource).toBe("https://two.example/final");
  });

  it("rejects a connected address that differs from the DNS-pinned address", async () => {
    const handler = createWebGetHandler({
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => response({ connectedAddress: "10.0.0.1" }),
    });
    await expect(handler({ url: "https://example.com" }, context())).rejects.toMatchObject({ code: "dns_rebinding" });
  });

  it("enforces redirects, content type, response size, and JSON validity", async () => {
    const publicResolve = async () => [{ address: "93.184.216.34", family: 4 as const }];
    const redirects = createWebGetHandler({ maxRedirects: 0, resolve: publicResolve, request: async () => response({ status: 301, headers: { location: "https://example.com/two" }, body: Buffer.alloc(0), compressedBytes: 0 }) });
    await expect(redirects({ url: "https://example.com" }, context())).rejects.toMatchObject({ code: "too_many_redirects" });
    const binary = createWebGetHandler({ resolve: publicResolve, request: async () => response({ headers: { "content-type": "application/octet-stream" } }) });
    await expect(binary({ url: "https://example.com", responseFormat: "text" }, context())).rejects.toMatchObject({ code: "unsupported_content_type" });
    const oversized = createWebGetHandler({ resolve: publicResolve, request: async () => response({ body: Buffer.alloc(6), compressedBytes: 6 }) });
    await expect(oversized({ url: "https://example.com", maxResponseBytes: 5 }, context())).rejects.toMatchObject({ code: "response_too_large" });
    const invalidJson = createWebGetHandler({ resolve: publicResolve, request: async () => response({ headers: { "content-type": "application/json" }, body: Buffer.from("no") }) });
    await expect(invalidJson({ url: "https://example.com", responseFormat: "json" }, context())).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("stores binary and model-oversized responses as workspace artifacts", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "web-get-"));
    temporaryDirectories.push(workspaceRoot);
    const handler = createWebGetHandler({
      maxModelBytes: 3,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => response({ body: Buffer.from("hello"), compressedBytes: 5 }),
    });

    const result = await handler({ url: "https://example.com/file" }, context(workspaceRoot));

    expect(result.data).toBeUndefined();
    expect(result.artifact).toMatchObject({ contentType: "text/plain", byteCount: 5 });
    expect(await readFile(result.artifact!.path, "utf8")).toBe("hello");
  });
});

describe("isPublicAddress", () => {
  it("accepts routable IPv4 and IPv6 addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
});
