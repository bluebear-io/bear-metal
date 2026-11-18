import { Compile } from "typebox/schema";
import type { TaskProfile } from "../customization/types.js";

const MAX_DEADLINE_MS = 7 * 24 * 60 * 60_000;

/**
 * A task submitted through the task API. With `ticketId` it is a coding task: Bear Metal assigns the ticket to
 * `owner`, delegates it to itself and runs it as a ticket task. Without one it runs once in `repository`, cannot
 * change code, and ends with `submit_result`.
 */
export interface ApiTaskRequest {
  /** A retry with the same key and body returns the same task; the same key with another body is rejected. */
  idempotencyKey: string;
  /** The settings the task runs with; `customizeTask` decides what they mean. */
  profile: TaskProfile;
  /** Email of the human who owns the session; a coding task's ticket is assigned to them. */
  owner: string;
  /** Linear identifier or id of the ticket a coding task works on. */
  ticketId?: string;
  /** `owner/name` on GitHub; required without `ticketId`, refused with it. */
  repository?: string;
  /** A coding task's first run gets `instruction` and `inputs` in its prompt; later runs do not. */
  instruction: string;
  inputs?: Record<string, unknown>;
  /** JSON schema the agent's structured result must match; refused with `ticketId`. */
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
  /** The Linear id of a coding task's ticket. */
  ticketIssueId: string | null;
  result: ApiTaskResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export class ApiTaskRequestError extends Error {}

const REQUEST_FIELDS = new Set([
  "idempotencyKey", "profile", "owner", "ticketId", "repository", "instruction", "inputs", "outputSchema", "deadline", "maxTokens",
]);
const PROFILE_FIELDS = new Set(["id", "name", "instructions", "toolCeiling", "shell", "customerData", "labels"]);
const IDEMPOTENCY_KEY = /^[^\s]{1,200}$/;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const TICKET_ID = /^[A-Za-z0-9-]{1,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string, pattern?: RegExp, prefix = ""): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ApiTaskRequestError(`${prefix}${field} is required`);
  if (pattern && !pattern.test(value)) throw new ApiTaskRequestError(`${prefix}${field} is invalid`);
  return value;
}

function requiredBoolean(body: Record<string, unknown>, field: string, where: string): boolean {
  if (typeof body[field] !== "boolean") throw new ApiTaskRequestError(`${where}.${field} must be a boolean`);
  return body[field] as boolean;
}

function parseProfile(value: unknown): TaskProfile {
  if (!isRecord(value)) throw new ApiTaskRequestError("profile must be a JSON object");
  const unknown = Object.keys(value).find((field) => !PROFILE_FIELDS.has(field));
  if (unknown !== undefined) throw new ApiTaskRequestError(`unknown field profile.${unknown}`);
  const toolCeiling = value.toolCeiling;
  if (!Array.isArray(toolCeiling) || toolCeiling.some((tool) => typeof tool !== "string" || !tool)) {
    throw new ApiTaskRequestError("profile.toolCeiling must be an array of strings");
  }
  const profile: TaskProfile = {
    id: requiredString(value, "id", PROFILE_ID, "profile."),
    name: requiredString(value, "name", undefined, "profile."),
    instructions: requiredString(value, "instructions", undefined, "profile."),
    toolCeiling: toolCeiling as string[],
    shell: requiredBoolean(value, "shell", "profile"),
    customerData: requiredBoolean(value, "customerData", "profile"),
  };
  if (value.labels === undefined) return profile;
  if (!isRecord(value.labels) || Object.values(value.labels).some((label) => typeof label !== "string" || !label)) {
    throw new ApiTaskRequestError("profile.labels must map names to strings");
  }
  return { ...profile, labels: value.labels as Record<string, string> };
}

/** Validates a task request; throws ApiTaskRequestError naming the first invalid field. */
export function parseApiTaskRequest(body: unknown, now = new Date()): ApiTaskRequest {
  if (!isRecord(body)) throw new ApiTaskRequestError("request body must be a JSON object");
  const unknown = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown !== undefined) throw new ApiTaskRequestError(`unknown field ${unknown}`);
  const request: ApiTaskRequest = {
    idempotencyKey: requiredString(body, "idempotencyKey", IDEMPOTENCY_KEY),
    profile: parseProfile(body.profile),
    owner: requiredString(body, "owner"),
    instruction: requiredString(body, "instruction"),
    deadline: requiredString(body, "deadline"),
    maxTokens: 0,
  };
  if (body.ticketId !== undefined) {
    request.ticketId = requiredString(body, "ticketId", TICKET_ID);
    if (body.repository !== undefined) throw new ApiTaskRequestError("repository is not allowed with ticketId; the ticket's workspace is used");
    if (body.outputSchema !== undefined) throw new ApiTaskRequestError("outputSchema is not allowed with ticketId; a coding task ends with a pull request");
  } else {
    request.repository = requiredString(body, "repository", REPOSITORY);
  }
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
  // Node timers overflow past about 24.8 days and fire at once.
  if (deadline - now.getTime() > MAX_DEADLINE_MS) throw new ApiTaskRequestError("deadline must be within 7 days");
  if (!Number.isSafeInteger(body.maxTokens) || (body.maxTokens as number) <= 0) throw new ApiTaskRequestError("maxTokens must be a positive integer");
  request.maxTokens = body.maxTokens as number;
  return request;
}

/** Checks a submitted result against the request's `outputSchema`; returns the first errors, or an empty list. */
export function outputSchemaErrors(schema: Record<string, unknown>, value: unknown): string[] {
  const [, errors] = Compile(schema).Errors(value);
  return errors.slice(0, 5).map((error) => `${error.instancePath || "/"} ${error.message}`);
}
