import { lookup as dnsLookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { get as httpGet, type RequestOptions } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { AgentToolError, type AgentToolHandler, type AgentToolResponse } from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_MODEL_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ARTIFACT_DIRECTORY = ".bear-metal/agent-tool-artifacts";

const FIXED_HEADERS = Object.freeze({
  "user-agent": "Bear-Metal-Agent/1.0",
  accept: "text/plain, application/json;q=0.9, */*;q=0.1",
  "accept-encoding": "gzip, deflate, br",
});

type ResolvedAddress = { address: string; family: 4 | 6 };

export type WebGetRequestInput = {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  connectTimeoutMs: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
};

export type WebGetRequestResult = {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  compressedBytes: number;
  connectedAddress: string;
};

export type WebGetRequest = (input: WebGetRequestInput) => Promise<WebGetRequestResult>;

export type WebGetOptions = {
  allowHttp?: boolean;
  maxResponseBytes?: number;
  maxModelBytes?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
  resolve?: (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
  request?: WebGetRequest;
};

type WebGetArguments = {
  url: string;
  maxResponseBytes?: number;
  responseFormat?: "auto" | "text" | "json" | "artifact";
};

export function createWebGetHandler(options: WebGetOptions = {}): AgentToolHandler {
  const resolve = options.resolve ?? resolveAddresses;
  const request = options.request ?? nativeRequest;
  const configuredMax = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "configured max response size");
  const maxModelBytes = positiveInteger(options.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES, "model response size");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout");
  const connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, "connection timeout");
  const maxRedirects = nonNegativeInteger(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, "redirect limit");

  return async (rawArguments, context) => {
    const args = parseArguments(rawArguments);
    const requestedMax = args.maxResponseBytes === undefined
      ? configuredMax
      : Math.min(positiveInteger(args.maxResponseBytes, "maxResponseBytes"), configuredMax);
    let url = parseAndValidateUrl(args.url, options.allowHttp ?? false);
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    for (let redirects = 0; ; redirects += 1) {
      const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
      const literalFamily = isIP(hostname);
      const addresses = literalFamily
        ? [{ address: hostname, family: literalFamily as 4 | 6 }]
        : await resolve(hostname);
      if (addresses.length === 0) throw webError("dns_resolution_failed", `No addresses resolved for ${url.hostname}`, true);
      if (addresses.some(({ address }) => !isPublicAddress(address))) {
        throw webError("unsafe_destination", "The destination resolves to a non-public address");
      }

      const pinned = addresses[0]!;
      let result: WebGetRequestResult;
      try {
        result = await request({
          url,
          address: pinned.address,
          family: pinned.family,
          headers: FIXED_HEADERS,
          signal,
          connectTimeoutMs,
          maxCompressedBytes: requestedMax,
          maxDecompressedBytes: requestedMax,
        });
      } catch (error) {
        if (error instanceof AgentToolError) throw error;
        if (signal.aborted) throw webError("request_timeout", "Web request timed out", true, error);
        throw webError("request_failed", safeRequestMessage(error), true, error);
      }
      if (!sameAddress(result.connectedAddress, pinned.address)) {
        throw webError("dns_rebinding", "Connected address did not match the validated DNS address");
      }

      if (isRedirect(result.status)) {
        if (redirects >= maxRedirects) throw webError("too_many_redirects", "Web request exceeded the redirect limit");
        const location = result.headers.location;
        if (!location) throw webError("invalid_redirect", "Redirect response omitted the Location header");
        url = parseAndValidateUrl(new URL(location, url).href, options.allowHttp ?? false);
        continue;
      }
      if (result.status < 200 || result.status >= 300) {
        throw new AgentToolError({ code: "http_error", message: `Web request failed with HTTP ${result.status}`, provider: "web", status: result.status, retryable: result.status >= 500 });
      }
      if (result.body.byteLength > requestedMax || result.compressedBytes > requestedMax) {
        throw webError("response_too_large", "Web response exceeded maxResponseBytes");
      }

      return formatResponse(url, result, args.responseFormat, maxModelBytes, context.workspaceRoot);
    }
  };
}

function parseArguments(value: Record<string, unknown>): WebGetArguments {
  if (typeof value.url !== "string" || value.url.length === 0) throw webError("invalid_arguments", "url is required");
  const responseFormat = value.responseFormat ?? "auto";
  if (!(["auto", "text", "json", "artifact"] as const).includes(responseFormat as never)) {
    throw webError("invalid_arguments", "responseFormat must be auto, text, json, or artifact");
  }
  if (value.maxResponseBytes !== undefined && (typeof value.maxResponseBytes !== "number" || !Number.isInteger(value.maxResponseBytes))) {
    throw webError("invalid_arguments", "maxResponseBytes must be an integer");
  }
  return { url: value.url, maxResponseBytes: value.maxResponseBytes as number | undefined, responseFormat: responseFormat as WebGetArguments["responseFormat"] };
}

function parseAndValidateUrl(input: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw webError("invalid_url", "url must be an absolute HTTP(S) URL");
  }
  if (url.username || url.password) throw webError("unsafe_url", "URL credentials are not allowed");
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw webError("unsupported_protocol", allowHttp ? "Only HTTP and HTTPS URLs are allowed" : "Only HTTPS URLs are allowed");
  }
  if (!url.hostname || url.hostname.endsWith(".")) throw webError("invalid_url", "URL hostname is invalid");
  const allowedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== allowedPort) throw webError("unsafe_port", `Only port ${allowedPort} is allowed for ${url.protocol}`);
  return url;
}

async function resolveAddresses(hostname: string): Promise<ReadonlyArray<ResolvedAddress>> {
  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address, family }) => {
      if (family !== 4 && family !== 6) throw webError("dns_resolution_failed", `DNS returned an invalid address family for ${hostname}`);
      return { address, family };
    });
  } catch (error) {
    throw webError("dns_resolution_failed", `Could not resolve ${hostname}`, true, error);
  }
}

async function nativeRequest(input: WebGetRequestInput): Promise<WebGetRequestResult> {
  return new Promise((resolve, reject) => {
    const getter = input.url.protocol === "https:" ? httpsGet : httpGet;
    const requestOptions: RequestOptions = {
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      headers: input.headers,
      signal: input.signal,
      agent: false,
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
    };
    const req = getter(requestOptions, (response) => {
      const connectedAddress = response.socket.remoteAddress;
      if (!connectedAddress) {
        response.destroy();
        reject(webError("connection_failed", "Connected socket has no remote address", true));
        return;
      }
      const chunks: Buffer[] = [];
      let compressedBytes = 0;
      response.on("data", (chunk: Buffer) => {
        compressedBytes += chunk.byteLength;
        if (compressedBytes > input.maxCompressedBytes) {
          response.destroy(webError("response_too_large", "Compressed web response exceeded the size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const body = decompress(Buffer.concat(chunks), headerValue(response.headers["content-encoding"]), input.maxDecompressedBytes);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            const normalized = headerValue(value);
            if (normalized !== undefined) headers[name.toLowerCase()] = normalized;
          }
          resolve({ status: response.statusCode ?? 0, headers, body, compressedBytes, connectedAddress });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once("socket", (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => req.destroy(webError("connection_timeout", "Web connection timed out", true)), input.connectTimeoutMs);
      timer.unref();
      socket.once(input.url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    req.on("error", reject);
  });
}

function decompress(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  try {
    let result: Buffer;
    switch (encoding?.trim().toLowerCase()) {
      case undefined:
      case "identity": result = body; break;
      case "gzip": result = gunzipSync(body, { maxOutputLength: maxBytes }); break;
      case "deflate": result = inflateSync(body, { maxOutputLength: maxBytes }); break;
      case "br": result = brotliDecompressSync(body, { maxOutputLength: maxBytes }); break;
      default: throw webError("unsupported_content_encoding", `Unsupported content encoding: ${encoding}`);
    }
    if (result.byteLength > maxBytes) throw webError("response_too_large", "Decompressed web response exceeded the size limit");
    return result;
  } catch (error) {
    if (error instanceof AgentToolError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw webError("response_too_large", "Decompressed web response exceeded the size limit");
    }
    throw webError("invalid_compression", "Web response decompression failed", false, error);
  }
}

async function formatResponse(
  url: URL,
  result: WebGetRequestResult,
  format: WebGetArguments["responseFormat"] = "auto",
  maxModelBytes: number,
  workspaceRoot: string,
): Promise<AgentToolResponse> {
  const contentType = mediaType(result.headers["content-type"]);
  const textual = isTextContentType(contentType);
  if ((format === "text" || format === "json") && !textual) {
    throw webError("unsupported_content_type", `Cannot return ${contentType} as ${format}`);
  }
  const shouldStore = format === "artifact" || !textual || result.body.byteLength > maxModelBytes;
  const base: Omit<AgentToolResponse, "data" | "artifact"> = {
    source: { provider: "web", resource: url.href },
    pagination: { pages: 1, hasMore: false },
    bytes: { compressed: result.compressedBytes, decompressed: result.body.byteLength, returned: shouldStore ? 0 : result.body.byteLength },
    truncated: false,
  };
  if (shouldStore) {
    const directory = join(workspaceRoot, ARTIFACT_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const digest = createHash("sha256").update(result.body).digest("hex").slice(0, 12);
    const path = join(directory, `web-${digest}-${randomUUID()}${extensionFor(contentType)}`);
    await writeFile(path, result.body, { flag: "wx", mode: 0o600 });
    return { ...base, artifact: { path, contentType, byteCount: result.body.byteLength } };
  }
  const text = result.body.toString("utf8");
  if (format === "json" || (format === "auto" && isJsonContentType(contentType))) {
    try {
      return { ...base, data: JSON.parse(text) as unknown };
    } catch (error) {
      throw webError("invalid_json", "Web response is not valid JSON", false, error);
    }
  }
  return { ...base, data: text };
}

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");

const blockedV6 = new BlockList();
blockedV6.addAddress("::", "ipv6");
blockedV6.addAddress("::1", "ipv6");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28],
  ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return !blockedV6.check(address, "ipv6");
  return false;
}

function sameAddress(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(actual)?.[1];
  return mapped === expected;
}

function mediaType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function isTextContentType(value: string): boolean {
  return value.startsWith("text/") || isJsonContentType(value) || value === "application/xml" || value.endsWith("+xml");
}

function isJsonContentType(value: string): boolean {
  return value === "application/json" || value.endsWith("+json");
}

function extensionFor(contentType: string): string {
  if (isJsonContentType(contentType)) return ".json";
  if (contentType === "text/html") return ".html";
  if (contentType.startsWith("text/")) return ".txt";
  return ".bin";
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw webError("invalid_configuration", `${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw webError("invalid_configuration", `${name} must be a non-negative integer`);
  return value;
}

function safeRequestMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Web request was aborted";
  return "Web request failed";
}

function webError(code: string, message: string, retryable = false, cause?: unknown): AgentToolError {
  return new AgentToolError({ code, message, provider: "web", retryable, cause });
}
