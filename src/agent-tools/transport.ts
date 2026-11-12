import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { redactCredentials as redactCredentialText } from "../shared/redaction.js";
import { AgentToolError, type AgentToolProvider, type AgentToolResponse } from "./types.js";

const DEFAULT_ALLOWED_CONTENT_TYPES = ["application/json", "text/"];
const SENSITIVE_KEYS = /authorization|cookie|token|secret|private.?key|signature|signed/i;
const SENSITIVE_QUERY_KEYS = /token|secret|signature|credential|key/i;

export type AgentToolTransportOptions = {
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
};

export type AgentToolGetOptions = {
  source: AgentToolResponse["source"];
  workspaceRoot?: string;
  responseMode?: "inline" | "artifact" | "auto";
  maxAttempts?: number;
  timeoutMs?: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxModelBytes: number;
  allowedContentTypes?: string[];
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export class AgentToolTransport {
  private readonly fetch: typeof globalThis.fetch;
  private readonly retryDelayMs: number;

  constructor(options: AgentToolTransportOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.retryDelayMs = options.retryDelayMs ?? 100;
  }

  async get(url: string, options: AgentToolGetOptions): Promise<AgentToolResponse> {
    const maxAttempts = options.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new AgentToolError({ code: "invalid_limit", message: "maxAttempts must be a positive integer" });
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.getOnce(url, options);
      } catch (error) {
        lastError = error;
        const normalized = normalizeAgentToolError(error, options.source.provider);
        if (attempt === maxAttempts || !normalized.retryable) throw normalized;
        await delay(this.retryDelayMs, options.signal);
      }
    }
    throw normalizeAgentToolError(lastError, options.source.provider);
  }

  private async getOnce(url: string, options: AgentToolGetOptions): Promise<AgentToolResponse> {
    const timeoutSignal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
    const signal = combineSignals(options.signal, timeoutSignal);
    let response: Response;
    try {
      response = await this.fetch(url, { method: "GET", headers: options.headers, signal });
    } catch (error) {
      throw new AgentToolError({
        code: error instanceof Error && error.name === "AbortError" ? "timeout" : "transport_error",
        message: redactMessage(error instanceof Error ? error.message : String(error)),
        provider: options.source.provider,
        retryable: !(error instanceof Error && error.name === "AbortError"),
        cause: error,
      });
    }

    if (!response.ok) {
      throw new AgentToolError({
        code: "provider_error",
        message: `Provider returned HTTP ${response.status}`,
        provider: options.source.provider,
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      });
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
    const allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    if (!allowed.some((candidate) => contentType === candidate || (candidate.endsWith("/") && contentType.startsWith(candidate)))) {
      throw new AgentToolError({
        code: "unsupported_content_type",
        message: `Unsupported content type: ${contentType}`,
        provider: options.source.provider,
      });
    }

    const declaredCompressedBytes = parseContentLength(response.headers.get("content-length"));
    if (declaredCompressedBytes !== null && declaredCompressedBytes > options.maxCompressedBytes) {
      throw tooLarge(options.source.provider, "compressed");
    }
    const body = await readResponseBody(response, options.maxDecompressedBytes, () => tooLarge(options.source.provider, "decompressed"));
    const compressedBytes = declaredCompressedBytes ?? body.byteLength;
    if (compressedBytes > options.maxCompressedBytes) {
      throw tooLarge(options.source.provider, "compressed");
    }

    const isText = contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json");
    const responseMode = options.responseMode ?? "auto";
    const shouldStore = responseMode === "artifact" || !isText || body.byteLength > options.maxModelBytes;
    if (shouldStore) {
      if (!options.workspaceRoot) {
        throw new AgentToolError({ code: "artifact_workspace_required", message: "workspaceRoot is required for artifact responses" });
      }
      const artifact = await writeArtifact(options.workspaceRoot, options.source.resource, contentType, body);
      return baseResponse(options.source, compressedBytes, body.byteLength, 0, {
        artifact,
        truncated: body.byteLength > options.maxModelBytes,
        truncationReason: body.byteLength > options.maxModelBytes ? "model_limit" : undefined,
      });
    }

    const returned = body.subarray(0, options.maxModelBytes);
    const text = returned.toString("utf8");
    const data = contentType === "application/json" || contentType.endsWith("+json") ? parseJson(text, options.source.provider) : text;
    return baseResponse(options.source, compressedBytes, body.byteLength, returned.byteLength, {
      data,
      truncated: returned.byteLength < body.byteLength,
      truncationReason: returned.byteLength < body.byteLength ? "model_limit" : undefined,
    });
  }
}

export function redactCredentials(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactCredentials(entry),
  ]));
}

export function redactSensitiveText(value: string): string {
  try {
    return JSON.stringify(redactCredentials(JSON.parse(value)));
  } catch {
    return redactString(value);
  }
}

export function normalizeAgentToolError(error: unknown, provider?: AgentToolProvider): AgentToolError {
  if (error instanceof AgentToolError) {
    return new AgentToolError({
      code: error.code,
      message: redactMessage(error.message),
      provider: error.provider ?? provider,
      retryable: error.retryable,
      status: error.status,
    });
  }
  return new AgentToolError({
    code: "provider_error",
    message: redactMessage(error instanceof Error ? error.message : String(error)),
    provider,
  });
}

export function enforcePaginationBudget(requested: number | undefined, maximum: number): number {
  const pages = requested ?? 1;
  if (!Number.isSafeInteger(pages) || pages < 1 || !Number.isSafeInteger(maximum) || maximum < 1) {
    throw new AgentToolError({ code: "invalid_page_budget", message: "Pagination budgets must be positive integers" });
  }
  return Math.min(pages, maximum);
}

export async function readResponseBody(response: Response, maxBytes: number, limitError: () => Error): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw limitError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
}

export type ArchiveEntry = { path: string; expandedBytes: number; contentType?: string };

export function validateArchiveEntries(entries: ArchiveEntry[], limits: {
  maxFiles: number;
  maxExpandedBytes: number;
  allowedContentTypes?: string[];
}): void {
  if (entries.length > limits.maxFiles) throw new AgentToolError({ code: "archive_file_limit", message: "Archive file count exceeds limit" });
  let expandedBytes = 0;
  for (const entry of entries) {
    if (!safeArchivePath(entry.path)) throw new AgentToolError({ code: "invalid_archive_path", message: `Unsafe archive entry path: ${entry.path}` });
    if (!Number.isSafeInteger(entry.expandedBytes) || entry.expandedBytes < 0) throw new AgentToolError({ code: "invalid_archive_size", message: "Archive entry expanded size is invalid" });
    expandedBytes += entry.expandedBytes;
    if (expandedBytes > limits.maxExpandedBytes) throw new AgentToolError({ code: "archive_size_limit", message: "Archive expanded size exceeds limit" });
    if (entry.contentType && limits.allowedContentTypes && !limits.allowedContentTypes.includes(entry.contentType)) {
      throw new AgentToolError({ code: "archive_content_type", message: `Archive entry content type is not permitted: ${entry.contentType}` });
    }
  }
}

function baseResponse(
  source: AgentToolResponse["source"],
  compressed: number,
  decompressed: number,
  returned: number,
  content: Pick<AgentToolResponse, "data" | "artifact" | "truncated" | "truncationReason">,
): AgentToolResponse {
  return {
    source,
    ...content,
    pagination: { pages: 1, hasMore: false },
    bytes: { compressed, decompressed, returned },
  };
}

async function writeArtifact(workspaceRoot: string, resource: string, contentType: string, body: Buffer) {
  const directory = resolve(workspaceRoot, ".bear-metal", "agent-tool-artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resourceName = basename(new URL(resource, "https://resource.invalid").pathname).replace(/[^a-zA-Z0-9._-]/g, "-") || "response";
  const path = resolve(directory, `${randomUUID()}-${resourceName}`);
  await writeFile(path, body, { mode: 0o600 });
  return { path, contentType, byteCount: body.byteLength };
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function tooLarge(provider: AgentToolProvider, kind: string): AgentToolError {
  return new AgentToolError({ code: "response_too_large", message: `Response ${kind} byte limit exceeded`, provider });
}

function parseJson(text: string, provider: AgentToolProvider): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AgentToolError({ code: "invalid_json", message: "Provider returned invalid JSON", provider, cause: error });
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return active.length === 0 ? undefined : AbortSignal.any(active);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function redactMessage(message: string): string {
  return redactCredentialText(message
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[REDACTED]")
    .replace(/(token|secret|signature|private.?key)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]"));
}

function redactString(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return redactMessage(value);
  }
}

function safeArchivePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const resolved = resolve("/archive", path);
  const rel = relative("/archive", resolved);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
