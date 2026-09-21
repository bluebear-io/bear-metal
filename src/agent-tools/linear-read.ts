import {
  Kind,
  parse,
  type ArgumentNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import type { TokenProvider } from "../shared/integrations/linear/token.js";
import { redactCredentials } from "./transport.js";
import { AgentToolError, type AgentToolHandler, type AgentToolResponse } from "./types.js";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_MAX_VARIABLE_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_FIELDS = 500;
const DEFAULT_MAX_ALIASES = 100;
const DEFAULT_MAX_FRAGMENTS = 50;
const DEFAULT_MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGINATION_ITEMS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export type LinearGraphqlRequest = {
  token: string;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  signal: AbortSignal;
  maxResponseBytes: number;
};

export type LinearGraphqlResult = { status: number; body: string };

export type LinearGraphqlExecute = (request: LinearGraphqlRequest) => Promise<LinearGraphqlResult>;

export type LinearReadOptions = {
  tokenProvider: TokenProvider;
  execute?: LinearGraphqlExecute;
  maxDocumentBytes?: number;
  maxVariableBytes?: number;
  maxDepth?: number;
  maxFields?: number;
  maxAliases?: number;
  maxFragments?: number;
  maxPageSize?: number;
  maxPaginationItems?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

type LinearReadArguments = {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
};

type GraphqlPayload = { data?: unknown; errors?: unknown };

export function createLinearReadHandler(options: LinearReadOptions): AgentToolHandler {
  const limits = {
    documentBytes: positiveInteger(options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES, "maxDocumentBytes"),
    variableBytes: positiveInteger(options.maxVariableBytes ?? DEFAULT_MAX_VARIABLE_BYTES, "maxVariableBytes"),
    depth: positiveInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, "maxDepth"),
    fields: positiveInteger(options.maxFields ?? DEFAULT_MAX_FIELDS, "maxFields"),
    aliases: nonNegativeInteger(options.maxAliases ?? DEFAULT_MAX_ALIASES, "maxAliases"),
    fragments: nonNegativeInteger(options.maxFragments ?? DEFAULT_MAX_FRAGMENTS, "maxFragments"),
    pageSize: positiveInteger(options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE, "maxPageSize"),
    paginationItems: positiveInteger(options.maxPaginationItems ?? DEFAULT_MAX_PAGINATION_ITEMS, "maxPaginationItems"),
    responseBytes: positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes"),
    timeoutMs: positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
  };
  const execute = options.execute ?? executeLinearGraphql;

  return async (rawArguments, context) => {
    const args = parseArguments(rawArguments);
    const queryBytes = Buffer.byteLength(args.query);
    if (queryBytes > limits.documentBytes) throw linearError("query_too_large", "GraphQL document exceeds the byte limit");
    const variableBytes = byteLengthJson(args.variables, "variables");
    if (variableBytes > limits.variableBytes) throw linearError("variables_too_large", "GraphQL variables exceed the byte limit");

    let document: DocumentNode;
    try {
      document = parse(args.query);
    } catch (error) {
      throw linearError("invalid_query", "GraphQL document is invalid", false, undefined, error);
    }
    const operation = validateDocument(document, args, limits);
    const resource = `graphql:${operation.name?.value ?? "anonymous"}`;
    const timeoutSignal = AbortSignal.timeout(limits.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;

    let result: LinearGraphqlResult;
    try {
      result = await requestWithAuthRefresh(options.tokenProvider, execute, args, signal, limits.responseBytes);
    } catch (error) {
      if (signal.aborted) throw linearError("request_timeout", "Linear request timed out", true, undefined, error);
      if (error instanceof AgentToolError) throw error;
      throw linearError("request_failed", "Linear request failed", true, undefined, error);
    }
    if (Buffer.byteLength(result.body) > limits.responseBytes) {
      throw linearError("response_too_large", "Linear response exceeds the byte limit");
    }
    if (result.status < 200 || result.status >= 300) {
      throw linearError("provider_error", `Linear returned HTTP ${result.status}`, result.status === 429 || result.status >= 500, result.status);
    }

    let payload: GraphqlPayload;
    try {
      payload = JSON.parse(result.body) as GraphqlPayload;
    } catch (error) {
      throw linearError("invalid_response", "Linear returned invalid JSON", false, result.status, error);
    }
    if (!payload || typeof payload !== "object" || (!("data" in payload) && !("errors" in payload))) {
      throw linearError("invalid_response", "Linear returned an invalid GraphQL response");
    }
    const safeData = redactCredentials(payload.data);
    const safeErrors = redactCredentials(payload.errors);
    const bodyBytes = Buffer.byteLength(result.body);
    const response: AgentToolResponse = {
      source: { provider: "linear", resource },
      ...(payload.data !== undefined ? { data: safeData } : {}),
      ...(payload.errors !== undefined ? { errors: safeErrors } : {}),
      pagination: paginationState(safeData),
      bytes: { compressed: bodyBytes, decompressed: bodyBytes, returned: bodyBytes },
      truncated: false,
    };
    return response;
  };
}

function parseArguments(value: Record<string, unknown>): LinearReadArguments {
  if (typeof value.query !== "string" || value.query.trim().length === 0) throw linearError("invalid_arguments", "query is required");
  if (value.operationName !== undefined && (typeof value.operationName !== "string" || value.operationName.length === 0)) {
    throw linearError("invalid_arguments", "operationName must be a non-empty string");
  }
  if (value.variables !== undefined && (!value.variables || typeof value.variables !== "object" || Array.isArray(value.variables))) {
    throw linearError("invalid_arguments", "variables must be an object");
  }
  return {
    query: value.query,
    variables: (value.variables ?? {}) as Record<string, unknown>,
    operationName: value.operationName as string | undefined,
  };
}

function validateDocument(
  document: DocumentNode,
  args: LinearReadArguments,
  limits: { depth: number; fields: number; aliases: number; fragments: number; pageSize: number; paginationItems: number },
): OperationDefinitionNode {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) throw linearError("operation_required", "GraphQL document must contain a query operation");
  if (operations.some(({ operation }) => operation !== "query")) {
    throw linearError("read_only_query_required", "linear_read permits query operations only");
  }
  const operation = args.operationName
    ? operations.find(({ name }) => name?.value === args.operationName)
    : operations.length === 1 ? operations[0] : undefined;
  if (!operation) {
    throw linearError(args.operationName ? "unknown_operation" : "operation_name_required", args.operationName
      ? `GraphQL operation ${args.operationName} was not found`
      : "operationName is required when a document contains multiple operations");
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    if (fragments.has(definition.name.value)) throw linearError("duplicate_fragment", `Duplicate fragment ${definition.name.value}`);
    fragments.set(definition.name.value, definition);
  }
  if (fragments.size > limits.fragments) throw linearError("query_fragments_exceeded", "GraphQL fragment limit exceeded");

  const counts = { fields: 0, aliases: 0, paginationItems: 0 };
  inspectSelection(operation.selectionSet, 1, new Set(), fragments, args.variables, limits, counts);
  return operation;
}

function inspectSelection(
  selectionSet: SelectionSetNode,
  depth: number,
  fragmentPath: Set<string>,
  fragments: Map<string, FragmentDefinitionNode>,
  variables: Record<string, unknown>,
  limits: { depth: number; fields: number; aliases: number; pageSize: number; paginationItems: number },
  counts: { fields: number; aliases: number; paginationItems: number },
): void {
  if (depth > limits.depth) throw linearError("query_depth_exceeded", "GraphQL query depth limit exceeded");
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      counts.fields += 1;
      if (counts.fields > limits.fields) throw linearError("query_fields_exceeded", "GraphQL field limit exceeded");
      if (selection.alias) {
        counts.aliases += 1;
        if (counts.aliases > limits.aliases) throw linearError("query_aliases_exceeded", "GraphQL alias limit exceeded");
      }
      if (selection.name.value.startsWith("__")) throw linearError("introspection_forbidden", "GraphQL introspection is not permitted");
      inspectPagination(selection.arguments ?? [], variables, limits, counts);
      if (selection.selectionSet) inspectSelection(selection.selectionSet, depth + 1, fragmentPath, fragments, variables, limits, counts);
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      inspectSelection(selection.selectionSet, depth, fragmentPath, fragments, variables, limits, counts);
      continue;
    }
    const name = selection.name.value;
    const fragment = fragments.get(name);
    if (!fragment) throw linearError("undefined_fragment", `Fragment ${name} is not defined`);
    if (fragmentPath.has(name)) throw linearError("fragment_cycle", `Fragment cycle includes ${name}`);
    const nextPath = new Set(fragmentPath);
    nextPath.add(name);
    inspectSelection(fragment.selectionSet, depth, nextPath, fragments, variables, limits, counts);
  }
}

function inspectPagination(
  args: readonly ArgumentNode[],
  variables: Record<string, unknown>,
  limits: { pageSize: number; paginationItems: number },
  counts: { paginationItems: number },
): void {
  for (const argument of args) {
    if (argument.name.value !== "first" && argument.name.value !== "last") continue;
    const value = paginationValue(argument.value, variables);
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw linearError("invalid_pagination", `${argument.name.value} must be a positive integer`);
    if (value > limits.pageSize) throw linearError("pagination_limit_exceeded", "GraphQL page size limit exceeded");
    counts.paginationItems += value;
    if (counts.paginationItems > limits.paginationItems) throw linearError("pagination_budget_exceeded", "GraphQL pagination budget exceeded");
  }
}

function paginationValue(value: ValueNode, variables: Record<string, unknown>): number | undefined {
  if (value.kind === Kind.INT) return Number(value.value);
  if (value.kind === Kind.VARIABLE) {
    const resolved = variables[value.name.value];
    if (resolved === undefined || resolved === null) return undefined;
    if (typeof resolved !== "number") throw linearError("invalid_pagination", `Pagination variable $${value.name.value} must be an integer`);
    return resolved;
  }
  throw linearError("invalid_pagination", "Pagination arguments must be integer literals or variables");
}

async function requestWithAuthRefresh(
  tokenProvider: TokenProvider,
  execute: LinearGraphqlExecute,
  args: LinearReadArguments,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<LinearGraphqlResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await execute({ token: await tokenProvider.getToken(), ...args, signal, maxResponseBytes });
    if ((result.status === 401 || result.status === 403) && attempt === 0) {
      tokenProvider.invalidate();
      continue;
    }
    return result;
  }
  throw linearError("authentication_failed", "Linear authentication failed");
}

async function executeLinearGraphql(request: LinearGraphqlRequest): Promise<LinearGraphqlResult> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: request.query, variables: request.variables, operationName: request.operationName }),
    signal: request.signal,
  });
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > request.maxResponseBytes) {
    await response.body?.cancel();
    throw linearError("response_too_large", "Linear response exceeds the byte limit");
  }
  if (!response.body) return { status: response.status, body: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > request.maxResponseBytes) {
      await reader.cancel();
      throw linearError("response_too_large", "Linear response exceeds the byte limit");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
  return { status: response.status, body };
}

function paginationState(data: unknown): AgentToolResponse["pagination"] {
  const stack = [data];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const pageInfo = record.pageInfo;
    if (pageInfo && typeof pageInfo === "object") {
      const info = pageInfo as Record<string, unknown>;
      if (info.hasNextPage === true) {
        return { pages: 1, hasMore: true, ...(typeof info.endCursor === "string" ? { next: info.endCursor } : {}) };
      }
    }
    stack.push(...(Array.isArray(value) ? value : Object.values(record)));
  }
  return { pages: 1, hasMore: false };
}

function byteLengthJson(value: unknown, label: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (error) {
    throw linearError("invalid_arguments", `${label} must be JSON serializable`, false, undefined, error);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function linearError(code: string, message: string, retryable = false, status?: number, cause?: unknown): AgentToolError {
  return new AgentToolError({ code, message, provider: "linear", retryable, status, cause });
}
