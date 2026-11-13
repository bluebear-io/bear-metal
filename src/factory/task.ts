import { createHash } from "node:crypto";
import { Compile } from "typebox/schema";

/** A workflow-factory agent step, as the factory submits it. */
export interface FactoryTaskRequest {
  /** `attemptId:fencingToken`. A higher fencing token for the same attempt supersedes the older task. */
  idempotencyKey: string;
  /** The factory run, used as the correlation id. */
  runId: string;
  /** The human who owns the session; BlueBear reports it as the session owner. */
  owner: string;
  role: string;
  grants: string[];
  /** `owner/name` on GitHub. */
  repository: string;
  baseSha: string;
  /** `wf/run/...`; absent for read-only steps, which then cannot push. */
  scratchBranch?: string;
  instruction: string;
  inputs?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** ISO timestamp; the task stops itself here and reports `timeout`. */
  deadline: string;
  /** Fresh-token budget; the task stops itself here and reports `budget`. */
  maxTokens: number;
}

export type FactoryTaskTerminalStatus = "succeeded" | "failed" | "timeout" | "budget" | "canceled" | "superseded";
export type FactoryTaskStatus = "queued" | "running" | FactoryTaskTerminalStatus;

export interface FactoryCheck {
  name: string;
  status: "passed" | "failed" | "not_run";
  detail?: string;
}

/** An outward effect the factory performs after the task, such as `github.comment`. Bear Metal never performs it. */
export type FactoryEffect = { type: string } & Record<string, unknown>;

export interface FactoryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshTokens: number;
}

export interface FactoryTaskResult {
  message: string | null;
  result: Record<string, unknown> | null;
  checks: FactoryCheck[];
  effects: FactoryEffect[];
  scratch: { branch: string; sha: string; commits: string[] } | null;
  usage: FactoryUsage | null;
  /** S3 keys under `staging/<taskId>/` in the factory artifact bucket. */
  artifacts: { name: string; key: string }[];
}

export interface FactoryTaskRecord {
  id: string;
  status: FactoryTaskStatus;
  request: FactoryTaskRequest;
  result: FactoryTaskResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export class FactoryRequestError extends Error {}

const REQUEST_FIELDS = new Set([
  "idempotencyKey", "runId", "owner", "role", "grants", "repository", "baseSha", "scratchBranch",
  "instruction", "inputs", "outputSchema", "deadline", "maxTokens",
]);
const IDEMPOTENCY_KEY = /^([^\s:][^\s]{0,199}):(0|[1-9]\d{0,8})$/;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const SCRATCH_BRANCH = /^wf\/run\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string, pattern?: RegExp): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new FactoryRequestError(`${field} is required`);
  if (pattern && !pattern.test(value)) throw new FactoryRequestError(`${field} is invalid`);
  return value;
}

/** Validates a task request; throws FactoryRequestError naming the first invalid field. */
export function parseFactoryTaskRequest(body: unknown, now = new Date()): FactoryTaskRequest {
  if (!isRecord(body)) throw new FactoryRequestError("request body must be a JSON object");
  const unknown = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown !== undefined) throw new FactoryRequestError(`unknown field ${unknown}`);
  const request: FactoryTaskRequest = {
    idempotencyKey: requiredString(body, "idempotencyKey", IDEMPOTENCY_KEY),
    runId: requiredString(body, "runId"),
    owner: requiredString(body, "owner", EMAIL),
    role: requiredString(body, "role", PROFILE_ID),
    grants: [],
    repository: requiredString(body, "repository", REPOSITORY),
    baseSha: requiredString(body, "baseSha", SHA),
    instruction: requiredString(body, "instruction"),
    deadline: requiredString(body, "deadline"),
    maxTokens: 0,
  };
  if (!Array.isArray(body.grants) || body.grants.some((grant) => typeof grant !== "string" || !grant.trim())) {
    throw new FactoryRequestError("grants must be an array of capability names");
  }
  if (new Set(body.grants).size !== body.grants.length) throw new FactoryRequestError("grants must not repeat");
  request.grants = body.grants as string[];
  if (body.scratchBranch !== undefined) {
    const branch = requiredString(body, "scratchBranch", SCRATCH_BRANCH);
    if (branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) || branch.includes("..")) {
      throw new FactoryRequestError("scratchBranch is invalid");
    }
    request.scratchBranch = branch;
  }
  if (body.inputs !== undefined) {
    if (!isRecord(body.inputs)) throw new FactoryRequestError("inputs must be a JSON object");
    request.inputs = body.inputs;
  }
  if (body.outputSchema !== undefined) {
    if (!isRecord(body.outputSchema)) throw new FactoryRequestError("outputSchema must be a JSON schema object");
    try {
      Compile(body.outputSchema);
    } catch (err) {
      throw new FactoryRequestError(`outputSchema is not a valid JSON schema: ${err instanceof Error ? err.message : String(err)}`);
    }
    request.outputSchema = body.outputSchema;
  }
  const deadline = Date.parse(request.deadline);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(request.deadline) || Number.isNaN(deadline)) throw new FactoryRequestError("deadline must be an ISO timestamp");
  if (deadline <= now.getTime()) throw new FactoryRequestError("deadline has passed");
  if (!Number.isSafeInteger(body.maxTokens) || (body.maxTokens as number) <= 0) throw new FactoryRequestError("maxTokens must be a positive integer");
  request.maxTokens = body.maxTokens as number;
  return request;
}

export function splitIdempotencyKey(key: string): { attemptId: string; fencingToken: number } {
  const match = IDEMPOTENCY_KEY.exec(key);
  if (!match) throw new FactoryRequestError("idempotencyKey is invalid");
  return { attemptId: match[1]!, fencingToken: Number(match[2]) };
}

/** Hash of the request with object keys sorted, so a retry with reordered fields matches. */
export function factoryRequestHash(request: FactoryTaskRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Checks a submitted result against the step's `outputSchema`; returns the first errors, or an empty list. */
export function outputSchemaErrors(schema: Record<string, unknown>, value: unknown): string[] {
  const [, errors] = Compile(schema).Errors(value);
  return errors.slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
