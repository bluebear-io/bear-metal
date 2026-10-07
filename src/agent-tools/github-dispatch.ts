import { AgentToolError, type AgentToolHandler, type AgentToolResponse } from "./types.js";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const SENSITIVE_INPUT_KEY = /authorization|cookie|token|secret|password|private.?key|signature|credential/i;

export interface GitHubDispatchTokenProvider {
  getInstallationToken(): Promise<string>;
}

export type GitHubDispatchPolicy = {
  repositories: readonly string[];
  workflows: readonly string[];
  refs: readonly string[];
};

export type GitHubDispatchOptions = {
  tokenProvider: GitHubDispatchTokenProvider;
  policy: GitHubDispatchPolicy;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

type DispatchInput = {
  repository: string;
  workflow: string;
  ref: string;
  inputs: Record<string, string | number | boolean>;
};

export function createGitHubDispatchHandler(options: GitHubDispatchOptions): AgentToolHandler {
  validatePolicy(options.policy);
  const fetch = options.fetch ?? globalThis.fetch;

  return async (rawArgs, context) => {
    const input = parseInput(rawArgs);
    authorize(input, options.policy);
    return dispatch(fetch, options, input, context.signal);
  };
}

async function dispatch(
  fetch: typeof globalThis.fetch,
  options: GitHubDispatchOptions,
  input: DispatchInput,
  signal?: AbortSignal,
): Promise<AgentToolResponse> {
  const token = await options.tokenProvider.getInstallationToken();
  const resource = `/repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`;
  const url = `${API_ORIGIN}${resource}`;
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  let providerResponse: Response;
  try {
    providerResponse = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: requestSignal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: input.ref, inputs: input.inputs }),
    });
  } catch (error) {
    throw githubError(
      requestSignal.aborted ? (signal?.aborted ? "cancelled" : "timeout") : "transport_error",
      requestSignal.aborted ? "GitHub workflow dispatch was cancelled or timed out" : "GitHub workflow dispatch request failed",
      undefined,
      error,
    );
  }

  const body = Buffer.from(await providerResponse.arrayBuffer());
  if (!providerResponse.ok) {
    const message = providerMessage(body, providerResponse.headers.get("content-type"));
    throw githubError(
      providerResponse.status === 401 || providerResponse.status === 403 ? "github_dispatch_permission_denied" : "github_dispatch_failed",
      `GitHub workflow dispatch returned HTTP ${providerResponse.status}${message ? `: ${message}` : ""}`,
      providerResponse.status,
    );
  }

  const discovered = discoveredRun(body, providerResponse.headers.get("content-type"), providerResponse.headers.get("location"));
  const followWith = `/repos/${input.repository}/actions/workflows/${encodeURIComponent(input.workflow)}/runs`;
  const data = {
    accepted: true,
    repository: input.repository,
    workflow: input.workflow,
    ref: input.ref,
    inputs: sanitizeInputs(input.inputs),
    followWith,
    ...discovered,
  };
  const returned = Buffer.byteLength(JSON.stringify(data));
  return {
    source: { provider: "github", resource },
    data,
    pagination: { pages: 1, hasMore: false },
    bytes: { compressed: body.byteLength, decompressed: body.byteLength, returned },
    truncated: false,
  };
}

function parseInput(args: Record<string, unknown>): DispatchInput {
  const repository = requiredString(args.repository, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw githubError("invalid_dispatch_repository", "repository must use owner/name form");
  const workflow = requiredString(args.workflow, "workflow");
  if (!/^([1-9]\d*|[A-Za-z0-9_.-]+)$/.test(workflow)) throw githubError("invalid_dispatch_workflow", "workflow must be a workflow file name or numeric id");
  const ref = requiredString(args.ref, "ref");
  if (ref.length > 255 || /[\x00-\x20~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith(".") || ref.endsWith("/")) {
    throw githubError("invalid_dispatch_ref", "ref is not a valid Git ref");
  }
  const inputs: DispatchInput["inputs"] = {};
  if (args.inputs !== undefined) {
    if (!args.inputs || Array.isArray(args.inputs) || typeof args.inputs !== "object") throw githubError("invalid_dispatch_inputs", "inputs must be an object");
    const entries = Object.entries(args.inputs);
    if (entries.length > 25) throw githubError("invalid_dispatch_inputs", "inputs must contain at most 25 values");
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || (typeof value === "number" && !Number.isFinite(value))) {
        throw githubError("invalid_dispatch_inputs", `Invalid workflow input: ${key}`);
      }
      inputs[key] = value;
    }
    if (Buffer.byteLength(JSON.stringify(inputs)) > 65_535) throw githubError("invalid_dispatch_inputs", "inputs exceed the 65535-byte limit");
  }
  return { repository, workflow, ref, inputs };
}

function authorize(input: DispatchInput, policy: GitHubDispatchPolicy): void {
  if (!policy.repositories.includes(input.repository)) throw githubError("dispatch_repository_denied", `Repository ${input.repository} is not allowed`);
  if (!policy.workflows.includes(input.workflow)) throw githubError("dispatch_workflow_denied", `Workflow ${input.workflow} is not allowed`);
  if (!policy.refs.includes(input.ref)) throw githubError("dispatch_ref_denied", `Ref ${input.ref} is not allowed`);
}

function validatePolicy(policy: GitHubDispatchPolicy): void {
  if (!policy || policy.repositories.length === 0 || policy.workflows.length === 0 || policy.refs.length === 0) {
    throw new Error("GitHub dispatch policy requires non-empty repositories, workflows, and refs");
  }
}

function sanitizeInputs(inputs: DispatchInput["inputs"]): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, SENSITIVE_INPUT_KEY.test(key) ? "[REDACTED]" : value]));
}

function discoveredRun(body: Buffer, contentType: string | null, location: string | null): { runId?: number; runUrl?: string } {
  let runId: number | undefined;
  let runUrl: string | undefined;
  if (body.byteLength > 0 && contentType?.toLowerCase().includes("json")) {
    try {
      const data = JSON.parse(body.toString("utf8")) as { id?: unknown; html_url?: unknown };
      if (Number.isSafeInteger(data.id) && (data.id as number) > 0) runId = data.id as number;
      if (typeof data.html_url === "string" && URL.canParse(data.html_url) && new URL(data.html_url).origin === "https://github.com") runUrl = data.html_url;
    } catch {
      // A successful dispatch without a parseable response is still accepted and followable.
    }
  }
  if (!runUrl && location && URL.canParse(location) && new URL(location).origin === "https://github.com") runUrl = location;
  return { ...(runId ? { runId } : {}), ...(runUrl ? { runUrl } : {}) };
}

function providerMessage(body: Buffer, contentType: string | null): string | undefined {
  if (!contentType?.toLowerCase().includes("json")) return undefined;
  try {
    const data = JSON.parse(body.toString("utf8")) as { message?: unknown };
    return typeof data.message === "string" ? data.message : undefined;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw githubError(`invalid_dispatch_${field}`, `${field} must be a non-empty string`);
  return value;
}

function githubError(code: string, message: string, status?: number, cause?: unknown): AgentToolError {
  return new AgentToolError({ code, message, provider: "github", status, cause });
}
