import { Compile } from "typebox/schema";

/** A task submitted through the task API instead of a Linear ticket. */
export interface ApiTaskRequest {
  /** A retry with the same key and body returns the same task; the same key with another body is rejected. */
  idempotencyKey: string;
  /** The profile the task runs as; `customizeTask` decides what it means. */
  profile: string;
  /** Email of the human who owns the session. */
  owner: string;
  /** `owner/name` on GitHub. */
  repository: string;
  instruction: string;
  inputs?: Record<string, unknown>;
  /** JSON schema the agent's structured result must match. */
  outputSchema?: Record<string, unknown>;
  /** ISO timestamp; the task stops itself here and reports `timeout`. */
  deadline: string;
  /** Fresh-token budget; the task stops itself here and reports `budget`. */
  maxTokens: number;
}

export type ApiTaskTerminalStatus = "succeeded" | "failed" | "timeout" | "budget" | "canceled";
export type ApiTaskStatus = "queued" | "running" | ApiTaskTerminalStatus;

export interface ApiTaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshTokens: number;
}

export interface ApiTaskResult {
  message: string | null;
  result: Record<string, unknown> | null;
  pullRequests: { owner: string; repo: string; number: number }[];
  usage: ApiTaskUsage | null;
}

export interface ApiTaskRecord {
  id: string;
  status: ApiTaskStatus;
  request: ApiTaskRequest;
  result: ApiTaskResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export class ApiTaskRequestError extends Error {}

const REQUEST_FIELDS = new Set([
  "idempotencyKey", "profile", "owner", "repository", "instruction", "inputs", "outputSchema", "deadline", "maxTokens",
]);
const IDEMPOTENCY_KEY = /^[^\s]{1,200}$/;
const PROFILE = /^[a-z][a-z0-9-]{0,62}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string, pattern?: RegExp): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ApiTaskRequestError(`${field} is required`);
  if (pattern && !pattern.test(value)) throw new ApiTaskRequestError(`${field} is invalid`);
  return value;
}

/** Validates a task request; throws ApiTaskRequestError naming the first invalid field. */
export function parseApiTaskRequest(body: unknown, now = new Date()): ApiTaskRequest {
  if (!isRecord(body)) throw new ApiTaskRequestError("request body must be a JSON object");
  const unknown = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown !== undefined) throw new ApiTaskRequestError(`unknown field ${unknown}`);
  const request: ApiTaskRequest = {
    idempotencyKey: requiredString(body, "idempotencyKey", IDEMPOTENCY_KEY),
    profile: requiredString(body, "profile", PROFILE),
    owner: requiredString(body, "owner"),
    repository: requiredString(body, "repository", REPOSITORY),
    instruction: requiredString(body, "instruction"),
    deadline: requiredString(body, "deadline"),
    maxTokens: 0,
  };
  if (request.owner.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(request.owner)) throw new ApiTaskRequestError("owner is invalid");
  if (body.inputs !== undefined) {
    if (!isRecord(body.inputs)) throw new ApiTaskRequestError("inputs must be a JSON object");
    request.inputs = body.inputs;
  }
  if (body.outputSchema !== undefined) {
    if (!isRecord(body.outputSchema)) throw new ApiTaskRequestError("outputSchema must be a JSON schema object");
    try {
      Compile(body.outputSchema);
    } catch (err) {
      throw new ApiTaskRequestError(`outputSchema is not a valid JSON schema: ${err instanceof Error ? err.message : String(err)}`);
    }
    request.outputSchema = body.outputSchema;
  }
  const deadline = Date.parse(request.deadline);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(request.deadline) || Number.isNaN(deadline)) throw new ApiTaskRequestError("deadline must be an ISO timestamp");
  if (deadline <= now.getTime()) throw new ApiTaskRequestError("deadline has passed");
  if (!Number.isSafeInteger(body.maxTokens) || (body.maxTokens as number) <= 0) throw new ApiTaskRequestError("maxTokens must be a positive integer");
  request.maxTokens = body.maxTokens as number;
  return request;
}

/** Checks a submitted result against the request's `outputSchema`; returns the first errors, or an empty list. */
export function outputSchemaErrors(schema: Record<string, unknown>, value: unknown): string[] {
  const [, errors] = Compile(schema).Errors(value);
  return errors.slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
