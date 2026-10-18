import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { nativeRequest } from "./web-get.js";

describe("web_get native transport", () => {
  it("connects to the pinned address while preserving the HTTP hostname", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end(`${request.headers.host} ${request.url}`);
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server address missing");
      const result = await nativeRequest({
        url: new URL(`http://pinned.example:${address.port}/article?format=text`),
        address: "127.0.0.1",
        family: 4,
        headers: {},
        signal: AbortSignal.timeout(5_000),
        connectTimeoutMs: 1_000,
        maxCompressedBytes: 1_024,
        maxDecompressedBytes: 1_024,
      });

      expect(result.status).toBe(200);
      expect(result.connectedAddress).toBe("127.0.0.1");
      expect(result.body.toString()).toBe(`pinned.example:${address.port} /article?format=text`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
