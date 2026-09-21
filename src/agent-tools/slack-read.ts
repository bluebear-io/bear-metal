import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AgentToolError, type AgentToolExecutionContext, type AgentToolHandler, type AgentToolResponse } from "./types.js";
import { enforcePaginationBudget, readResponseBody } from "./transport.js";

export const SLACK_READ_OPERATIONS = [
  "conversation_discovery",
  "conversation_info",
  "conversation_history",
  "thread_replies",
  "user_lookup",
  "user_list",
  "message_search",
  "file_search",
  "file_download",
] as const;

export type SlackReadOperation = typeof SLACK_READ_OPERATIONS[number];

export interface SlackReadClientLike {
  call(method: string, params?: Readonly<Record<string, string | number | boolean>>, options?: { signal?: AbortSignal }): Promise<unknown>;
  downloadFile(url: string, options?: { signal?: AbortSignal; maxRedirects?: number }): Promise<Response>;
}

export type SlackReadLimits = {
  maxPages: number;
  maxItems: number;
  maxResponseBytes: number;
  maxFileBytes: number;
  maxHistoryRangeSeconds: number;
  maxDurationMs: number;
  maxRedirects: number;
  allowedFileContentTypes: string[];
};

const DEFAULT_LIMITS: SlackReadLimits = {
  maxPages: 5,
  maxItems: 500,
  maxResponseBytes: 1_000_000,
  maxFileBytes: 20_000_000,
  maxHistoryRangeSeconds: 31 * 24 * 60 * 60,
  maxDurationMs: 30_000,
  maxRedirects: 3,
  allowedFileContentTypes: ["text/", "application/json", "application/pdf", "application/zip", "image/"],
};

type OperationDefinition = {
  method: string;
  required: string[];
  allowed: string[];
  itemField?: string;
  pagination?: "cursor" | "page";
};

const OPERATIONS: Record<Exclude<SlackReadOperation, "file_download">, OperationDefinition> = {
  conversation_discovery: { method: "conversations.list", required: [], allowed: ["types", "exclude_archived", "team_id"], itemField: "channels" },
  conversation_info: { method: "conversations.info", required: ["channel"], allowed: ["channel", "include_locale", "include_num_members"] },
  conversation_history: { method: "conversations.history", required: ["channel"], allowed: ["channel", "oldest", "latest", "inclusive"], itemField: "messages" },
  thread_replies: { method: "conversations.replies", required: ["channel", "ts"], allowed: ["channel", "ts", "oldest", "latest", "inclusive"], itemField: "messages" },
  user_lookup: { method: "users.lookupByEmail", required: [], allowed: ["email", "user"] },
  user_list: { method: "users.list", required: [], allowed: ["include_locale", "team_id"], itemField: "members" },
  message_search: { method: "search.messages", required: ["query"], allowed: ["query", "sort", "sort_dir", "highlight"], itemField: "messages.matches", pagination: "page" },
  file_search: { method: "files.list", required: [], allowed: ["channel", "user", "ts_from", "ts_to", "types", "show_files_hidden_by_limit"], itemField: "files", pagination: "page" },
};

export class SlackReadError extends AgentToolError {
  readonly requiredScope?: string;

  constructor(input: ConstructorParameters<typeof AgentToolError>[0] & { requiredScope?: string }) {
    super(input);
    this.name = "SlackReadError";
    this.requiredScope = input.requiredScope;
  }
}

export function createSlackReadHandler(options: {
  client: SlackReadClientLike;
  limits?: Partial<SlackReadLimits>;
}): AgentToolHandler {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  validateLimits(limits);

  return async (args, context) => {
    const operation = parseOperation(args.operation);
    const parameters = parseParameters(args.parameters);
    const signal = AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(limits.maxDurationMs)]);

    if (operation === "file_download") {
      return downloadFile(options.client, parameters, context, signal, limits);
    }

    const definition = operation === "user_lookup" && parameters.user !== undefined
      ? { ...OPERATIONS.user_lookup, method: "users.info" }
      : OPERATIONS[operation];
    if (operation === "user_lookup" && (parameters.email === undefined) === (parameters.user === undefined)) {
      throw invalidArguments("user_lookup requires exactly one of email or user");
    }
    validateParameters(parameters, definition);
    validateHistoryRange(operation, parameters, limits.maxHistoryRangeSeconds);
    const pageBudget = enforcePaginationBudget(numberArgument(args.pageBudget, "pageBudget"), limits.maxPages);
    const itemLimit = Math.min(numberArgument(args.itemLimit, "itemLimit") ?? limits.maxItems, limits.maxItems);
    if (itemLimit < 1) throw invalidArguments("itemLimit must be a positive integer");

    return readPages(options.client, definition, parameters, context, signal, pageBudget, itemLimit, limits.maxResponseBytes);
  };
}

async function readPages(
  client: SlackReadClientLike,
  definition: OperationDefinition,
  parameters: Record<string, string | number | boolean>,
  _context: AgentToolExecutionContext,
  signal: AbortSignal,
  pageBudget: number,
  itemLimit: number,
  maxResponseBytes: number,
): Promise<AgentToolResponse> {
  const items: unknown[] = [];
  let next: string | undefined;
  let pages = 0;
  let bytes = 0;
  let lastBody: Record<string, unknown> = {};

  do {
    const remaining = itemLimit - items.length;
    const pageSizeKey = definition.pagination === "page" ? "count" : "limit";
    const pageKey = definition.pagination === "page" ? "page" : "cursor";
    const params = { ...parameters, ...(definition.itemField ? { [pageSizeKey]: Math.min(definition.pagination === "page" ? 100 : 200, remaining) } : {}), ...(next ? { [pageKey]: next } : {}) };
    const raw = await client.call(definition.method, params, { signal });
    const body = slackResponse(raw);
    assertSlackSuccess(body);
    pages += 1;
    lastBody = body;
    bytes += Buffer.byteLength(JSON.stringify(body));
    if (bytes > maxResponseBytes) throw new SlackReadError({ code: "response_too_large", message: "Slack response byte limit exceeded", provider: "slack" });

    if (!definition.itemField) break;
    const pageItems = fieldAtPath(body, definition.itemField);
    if (!Array.isArray(pageItems)) throw new SlackReadError({ code: "invalid_response", message: `Slack response omitted ${definition.itemField}`, provider: "slack" });
    items.push(...pageItems.slice(0, remaining));
    next = definition.pagination === "page" ? responsePage(body, definition.itemField) : responseCursor(body);
  } while (next && pages < pageBudget && items.length < itemLimit);

  const hasMore = Boolean(next);
  const data = definition.itemField ? { items } : lastBody;
  const returnedBytes = Buffer.byteLength(JSON.stringify(data));
  return {
    source: { provider: "slack", resource: definition.method },
    data,
    pagination: { pages, hasMore, ...(next ? { next } : {}) },
    bytes: { compressed: bytes, decompressed: bytes, returned: returnedBytes },
    truncated: hasMore,
    ...(hasMore ? { truncationReason: "page_limit" as const } : {}),
  };
}

async function downloadFile(
  client: SlackReadClientLike,
  parameters: Record<string, string | number | boolean>,
  context: AgentToolExecutionContext,
  signal: AbortSignal,
  limits: SlackReadLimits,
): Promise<AgentToolResponse> {
  validateParameters(parameters, { method: "file_download", required: ["url"], allowed: ["url"] });
  const url = parameters.url;
  if (typeof url !== "string" || !safeSlackFileUrl(url)) throw new SlackReadError({ code: "invalid_file_url", message: "Slack file URL must use HTTPS on a Slack host", provider: "slack" });
  const response = await client.downloadFile(url, { signal, maxRedirects: limits.maxRedirects });
  if (!response.ok) throw new SlackReadError({ code: "provider_error", message: `Slack file download returned HTTP ${response.status}`, provider: "slack", status: response.status });
  if (response.url && !safeSlackFileUrl(response.url)) throw new SlackReadError({ code: "unsafe_redirect", message: "Slack file download redirected to an untrusted host", provider: "slack" });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "application/octet-stream";
  if (!contentTypeAllowed(contentType, limits.allowedFileContentTypes)) throw new SlackReadError({ code: "unsupported_content_type", message: `Unsupported Slack file content type: ${contentType}`, provider: "slack" });
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > limits.maxFileBytes) throw fileTooLarge();
  const body = await readResponseBody(response, limits.maxFileBytes, fileTooLarge);

  const directory = resolve(context.workspaceRoot, ".bear-metal", "agent-tool-artifacts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = basename(new URL(url).pathname).replace(/[^a-zA-Z0-9._-]/g, "-") || "file";
  const path = resolve(directory, `slack-${randomUUID()}-${name}`);
  await writeFile(path, body, { mode: 0o600 });
  return {
    source: { provider: "slack", resource: url },
    artifact: { path, contentType, byteCount: body.byteLength },
    pagination: { pages: 1, hasMore: false },
    bytes: { compressed: body.byteLength, decompressed: body.byteLength, returned: 0 },
    truncated: false,
  };
}

function parseOperation(value: unknown): SlackReadOperation {
  if (typeof value !== "string" || !SLACK_READ_OPERATIONS.includes(value as SlackReadOperation)) {
    throw new SlackReadError({ code: "invalid_operation", message: "Unsupported Slack read operation", provider: "slack" });
  }
  return value as SlackReadOperation;
}

function parseParameters(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArguments("parameters must be an object");
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") throw invalidArguments("parameter values must be strings, numbers, or booleans");
  }
  return value as Record<string, string | number | boolean>;
}

function validateParameters(parameters: Record<string, unknown>, definition: OperationDefinition): void {
  const unknown = Object.keys(parameters).filter((key) => !definition.allowed.includes(key));
  const missing = definition.required.filter((key) => parameters[key] === undefined || parameters[key] === "");
  if (unknown.length > 0) throw invalidArguments(`Unknown parameters: ${unknown.join(", ")}`);
  if (missing.length > 0) throw invalidArguments(`Missing required parameters: ${missing.join(", ")}`);
}

function validateHistoryRange(operation: SlackReadOperation, parameters: Record<string, string | number | boolean>, maximum: number): void {
  if (operation !== "conversation_history" && operation !== "thread_replies") return;
  const oldest = numericTimestamp(parameters.oldest);
  const latest = numericTimestamp(parameters.latest);
  if (oldest !== undefined && latest !== undefined && latest - oldest > maximum) {
    throw new SlackReadError({ code: "history_range_limit", message: "Slack history range exceeds limit", provider: "slack" });
  }
}

function numericTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw invalidArguments("Slack timestamps must be non-negative numbers");
  return parsed;
}

function numberArgument(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalidArguments(`${name} must be a positive integer`);
  return value as number;
}

function slackResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SlackReadError({ code: "invalid_response", message: "Slack returned an invalid response", provider: "slack" });
  return value as Record<string, unknown>;
}

function assertSlackSuccess(body: Record<string, unknown>): void {
  if (body.ok === true) return;
  const error = typeof body.error === "string" ? body.error : "unknown_error";
  const requiredScope = typeof body.needed === "string" ? body.needed : undefined;
  throw new SlackReadError({
    code: error === "missing_scope" ? "missing_scope" : "provider_error",
    message: requiredScope ? `Slack requires scope: ${requiredScope}` : `Slack API error: ${error}`,
    provider: "slack",
    requiredScope,
  });
}

function responseCursor(body: Record<string, unknown>): string | undefined {
  const metadata = body.response_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const cursor = (metadata as Record<string, unknown>).next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

function responsePage(body: Record<string, unknown>, itemField: string): string | undefined {
  const parentPath = itemField.includes(".") ? itemField.slice(0, itemField.lastIndexOf(".")) : "";
  const parent = parentPath ? fieldAtPath(body, parentPath) : body;
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return undefined;
  const pagination = (parent as Record<string, unknown>).pagination ?? (parent as Record<string, unknown>).paging;
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) return undefined;
  const page = Number((pagination as Record<string, unknown>).page);
  const pages = Number((pagination as Record<string, unknown>).page_count ?? (pagination as Record<string, unknown>).pages);
  return Number.isSafeInteger(page) && Number.isSafeInteger(pages) && page < pages ? String(page + 1) : undefined;
}

function fieldAtPath(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function safeSlackFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

function contentTypeAllowed(contentType: string, allowed: string[]): boolean {
  return allowed.some((candidate) => candidate.endsWith("/") ? contentType.startsWith(candidate) : contentType === candidate);
}

function invalidArguments(message: string): SlackReadError {
  return new SlackReadError({ code: "invalid_arguments", message, provider: "slack" });
}

function fileTooLarge(): SlackReadError {
  return new SlackReadError({ code: "file_too_large", message: "Slack file exceeds byte limit", provider: "slack" });
}

function validateLimits(limits: SlackReadLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (name === "allowedFileContentTypes") continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Slack read limit ${name} must be a positive integer`);
  }
  if (limits.allowedFileContentTypes.length === 0) throw new Error("Slack read allowedFileContentTypes must not be empty");
}
