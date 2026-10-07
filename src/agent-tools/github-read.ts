import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentToolError, type AgentToolHandler, type AgentToolResponse } from "./types.js";
import { readResponseBody } from "./transport.js";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_MODEL_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;

export interface GitHubReadTokenProvider {
  getInstallationToken(): Promise<string>;
}

export type GitHubReadOptions = {
  tokenProvider: GitHubReadTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxModelBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

type GitHubReadInput = {
  path: string;
  query: Record<string, string | number | boolean | Array<string | number | boolean>>;
  pageBudget: number;
  responseMode: "inline" | "artifact" | "auto";
};

export function createGitHubReadHandler(options: GitHubReadOptions): AgentToolHandler {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (rawArgs, context) => {
    const input = parseInput(rawArgs);
    const initialUrl = buildApiUrl(input.path, input.query);
    const token = await options.tokenProvider.getInstallationToken();
    const startedAt = Date.now();
    const deadline = startedAt + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const pages: unknown[] = [];
    let compressedBytes = 0;
    let decompressedBytes = 0;
    let currentUrl: string | undefined = initialUrl;
    let lastContentType = "application/json";
    let finalBody: Buffer | undefined;
    let pageCount = 0;

    while (currentUrl && pageCount < input.pageBudget) {
      const page = await requestWithRetries(fetch, currentUrl, token, context.signal, deadline, options);
      const declaredBytes = parseContentLength(page.response.headers.get("content-length"));
      if (declaredBytes !== null && compressedBytes + declaredBytes > (options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES)) {
        await page.response.body?.cancel();
        throw responseTooLarge("compressed");
      }
      const remainingDecompressedBytes = (options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES) - decompressedBytes;
      const body = await readResponseBody(page.response, remainingDecompressedBytes, () => responseTooLarge("decompressed"));
      compressedBytes += declaredBytes ?? body.byteLength;
      decompressedBytes += body.byteLength;
      enforceByteLimits(compressedBytes, decompressedBytes, options);
      lastContentType = contentType(page.response);
      pageCount += 1;

      if (!page.response.ok) throw await githubResponseError(page.response, body);

      if (isJson(lastContentType)) {
        pages.push(parseJson(body));
      } else {
        finalBody = body;
      }

      currentUrl = nextLink(page.response.headers.get("link"));
      if (currentUrl) assertApiUrl(currentUrl, "GitHub pagination URL");
      if (finalBody) currentUrl = undefined;
    }

    const hasMore = currentUrl !== undefined;
    const resource = initialUrl;
    if (finalBody || input.responseMode === "artifact") {
      const body = finalBody ?? Buffer.from(JSON.stringify(combinePages(pages)));
      const artifact = await saveArtifact(context.workspaceRoot, resource, lastContentType, body);
      return response(resource, pageCount, hasMore, currentUrl, compressedBytes, decompressedBytes, 0, {
        artifact,
        truncated: hasMore,
        truncationReason: hasMore ? "page_limit" : undefined,
      });
    }

    const data = combinePages(pages);
    const serializedBytes = Buffer.byteLength(JSON.stringify(data));
    const maxModelBytes = options.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
    if (serializedBytes > maxModelBytes) {
      if (input.responseMode === "inline") {
        throw new AgentToolError({
          code: "response_too_large",
          message: `GitHub response exceeds the inline response limit of ${maxModelBytes} bytes; use responseMode=artifact`,
          provider: "github",
        });
      }
      const body = Buffer.from(JSON.stringify(data));
      const artifact = await saveArtifact(context.workspaceRoot, resource, "application/json", body);
      return response(resource, pageCount, hasMore, currentUrl, compressedBytes, decompressedBytes, 0, {
        artifact,
        truncated: true,
        truncationReason: hasMore ? "page_limit" : "model_limit",
      });
    }

    return response(resource, pageCount, hasMore, currentUrl, compressedBytes, decompressedBytes, serializedBytes, {
      data,
      truncated: hasMore,
      truncationReason: hasMore ? "page_limit" : undefined,
    });
  };
}

function parseInput(args: Record<string, unknown>): GitHubReadInput {
  if (typeof args.path !== "string" || args.path.length === 0 || args.path.length > 2_048) {
    throw invalidPath("path must be a non-empty relative GitHub REST API path");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(args.path) || args.path.startsWith("//") || args.path.includes("?") || args.path.includes("#") || args.path.split("/").includes("..")) {
    throw invalidPath("path must not contain a host, query string, or fragment");
  }
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  const url = new URL(path, API_ORIGIN);
  if (url.origin !== API_ORIGIN || url.pathname.split("/").includes("..")) throw invalidPath("path must remain under the GitHub API host");

  const query: GitHubReadInput["query"] = {};
  if (args.query !== undefined) {
    if (!args.query || Array.isArray(args.query) || typeof args.query !== "object") {
      throw new AgentToolError({ code: "invalid_github_query", message: "query must be an object", provider: "github" });
    }
    for (const [key, value] of Object.entries(args.query)) {
      if (!key || !validQueryValue(value)) {
        throw new AgentToolError({ code: "invalid_github_query", message: `Invalid GitHub query parameter: ${key}`, provider: "github" });
      }
      query[key] = value;
    }
  }

  const pageBudget = args.pageBudget ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(pageBudget) || (pageBudget as number) < 1 || (pageBudget as number) > MAX_PAGES) {
    throw new AgentToolError({ code: "invalid_page_budget", message: `pageBudget must be an integer from 1 to ${MAX_PAGES}`, provider: "github" });
  }
  const responseMode = args.responseMode ?? "auto";
  if (responseMode !== "inline" && responseMode !== "artifact" && responseMode !== "auto") {
    throw new AgentToolError({ code: "invalid_response_mode", message: "responseMode must be inline, artifact, or auto", provider: "github" });
  }
  return { path, query, pageBudget: pageBudget as number, responseMode };
}

function validQueryValue(value: unknown): value is GitHubReadInput["query"][string] {
  const scalar = (candidate: unknown) => typeof candidate === "string" || typeof candidate === "boolean" || (typeof candidate === "number" && Number.isFinite(candidate));
  return scalar(value) || (Array.isArray(value) && value.length <= 100 && value.every(scalar));
}

function buildApiUrl(path: string, query: GitHubReadInput["query"]): string {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url.toString();
}

async function requestFollowingRedirects(
  fetch: typeof globalThis.fetch,
  initialUrl: string,
  token: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<{ response: Response; url: string }> {
  let url = initialUrl;
  let sendAuthorization = new URL(url).origin === API_ORIGIN;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AgentToolError({ code: "timeout", message: "GitHub request timed out", provider: "github", retryable: true });
    const combinedSignal = AbortSignal.any([AbortSignal.timeout(remainingMs), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: combinedSignal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(sendAuthorization ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      throw new AgentToolError({
        code: combinedSignal.aborted ? "timeout" : "transport_error",
        message: combinedSignal.aborted ? "GitHub request timed out" : "GitHub request failed",
        provider: "github",
        retryable: true,
        cause: error,
      });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    if (redirects === MAX_REDIRECTS) throw new AgentToolError({ code: "redirect_limit", message: "GitHub redirect limit exceeded", provider: "github" });
    const location = response.headers.get("location");
    if (!location) throw new AgentToolError({ code: "invalid_redirect", message: "GitHub redirect omitted Location", provider: "github" });
    const next = new URL(location, url);
    if (next.protocol !== "https:") throw new AgentToolError({ code: "invalid_redirect", message: "GitHub redirects must use HTTPS", provider: "github" });
    sendAuthorization = sendAuthorization && next.origin === new URL(url).origin;
    url = next.toString();
  }
  throw new AgentToolError({ code: "redirect_limit", message: "GitHub redirect limit exceeded", provider: "github" });
}

async function requestWithRetries(
  fetch: typeof globalThis.fetch,
  url: string,
  token: string,
  signal: AbortSignal | undefined,
  deadline: number,
  options: GitHubReadOptions,
): Promise<{ response: Response; url: string }> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new AgentToolError({ code: "invalid_limit", message: "GitHub maxAttempts must be an integer from 1 to 5", provider: "github" });
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await requestFollowingRedirects(fetch, url, token, signal, deadline);
    if (attempt === maxAttempts || (result.response.status !== 429 && result.response.status < 500)) return result;
    await abortableDelay(options.retryDelayMs ?? 100, signal, deadline);
  }
  throw new AgentToolError({ code: "transport_error", message: "GitHub request failed", provider: "github", retryable: true });
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new AgentToolError({ code: "timeout", message: "GitHub request timed out", provider: "github", retryable: true });
  const delayMs = Math.min(milliseconds, remainingMs);
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new AgentToolError({ code: "cancelled", message: "GitHub request was cancelled", provider: "github" }));
    }, { once: true });
  });
}

async function githubResponseError(response: Response, body: Buffer): Promise<AgentToolError> {
  let providerMessage = "";
  if (isJson(contentType(response))) {
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { message?: unknown };
      if (typeof parsed.message === "string") providerMessage = `: ${parsed.message}`;
    } catch {
      providerMessage = "";
    }
  }
  const permissionContext = response.headers.get("x-accepted-github-permissions");
  const denied = response.status === 401 || response.status === 403;
  return new AgentToolError({
    code: denied ? "github_permission_denied" : "github_provider_error",
    message: denied
      ? `GitHub denied the agent integration request${providerMessage}${permissionContext ? `; required permissions: ${permissionContext}` : ""}`
      : `GitHub returned HTTP ${response.status}${providerMessage}`,
    provider: "github",
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

function response(
  resource: string,
  pages: number,
  hasMore: boolean,
  next: string | undefined,
  compressed: number,
  decompressed: number,
  returned: number,
  content: Pick<AgentToolResponse, "data" | "artifact" | "truncated" | "truncationReason">,
): AgentToolResponse {
  return {
    source: { provider: "github", resource },
    ...content,
    pagination: { pages, hasMore, ...(next ? { next } : {}) },
    bytes: { compressed, decompressed, returned },
  };
}

function combinePages(pages: unknown[]): unknown {
  if (pages.length === 1) return pages[0];
  if (pages.every(Array.isArray)) return pages.flat();
  return pages;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match?.[2]?.split(/\s+/).includes("next")) return match[1];
  }
  return undefined;
}

function assertApiUrl(url: string, label: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== API_ORIGIN) throw new AgentToolError({ code: "invalid_pagination_url", message: `${label} must use ${API_ORIGIN}`, provider: "github" });
}

function contentType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function isJson(type: string): boolean {
  return type === "application/json" || type.endsWith("+json");
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new AgentToolError({ code: "invalid_json", message: "GitHub returned invalid JSON", provider: "github", cause: error });
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function enforceByteLimits(compressed: number, decompressed: number, options: GitHubReadOptions): void {
  if (compressed > (options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES)) {
    throw new AgentToolError({ code: "response_too_large", message: "GitHub response compressed byte limit exceeded", provider: "github" });
  }
  if (decompressed > (options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES)) {
    throw new AgentToolError({ code: "response_too_large", message: "GitHub response decompressed byte limit exceeded", provider: "github" });
  }
}

function responseTooLarge(kind: "compressed" | "decompressed"): AgentToolError {
  return new AgentToolError({ code: "response_too_large", message: `GitHub ${kind} response byte limit exceeded`, provider: "github" });
}

async function saveArtifact(workspaceRoot: string, resource: string, contentType: string, body: Buffer) {
  const directory = resolve(workspaceRoot, ".bear-metal", "agent-tool-artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = basename(new URL(resource).pathname).replace(/[^a-zA-Z0-9._-]/g, "-") || "github-response";
  const path = resolve(directory, `${randomUUID()}-${name}`);
  await writeFile(path, body, { mode: 0o600 });
  return { path, contentType, byteCount: body.byteLength };
}

function invalidPath(message: string): AgentToolError {
  return new AgentToolError({ code: "invalid_github_path", message, provider: "github" });
}
