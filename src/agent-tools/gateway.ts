import type { Logger } from "../shared/index.js";
import {
  AgentToolError,
  type AgentToolAuditRecord,
  type AgentToolExecutionContext,
  type AgentToolGatewayLike,
  type AgentToolHandlers,
  type AgentToolName,
  type AgentToolRequest,
  type AgentToolResponse,
} from "./types.js";
import { normalizeAgentToolError, redactCredentials } from "./transport.js";

export type AgentToolGatewayOptions = {
  handlers: AgentToolHandlers;
  logger?: Pick<Logger, "info" | "warn">;
  onAudit?: (record: AgentToolAuditRecord) => void;
};

export class AgentToolGateway implements AgentToolGatewayLike {
  private readonly handlers: AgentToolHandlers;
  private readonly logger?: AgentToolGatewayOptions["logger"];
  private readonly onAudit?: AgentToolGatewayOptions["onAudit"];

  constructor(options: AgentToolGatewayOptions) {
    this.handlers = options.handlers;
    this.logger = options.logger;
    this.onAudit = options.onAudit;
  }

  availableTools(): readonly AgentToolName[] {
    return Object.keys(this.handlers) as AgentToolName[];
  }

  async execute(request: AgentToolRequest, context: AgentToolExecutionContext): Promise<AgentToolResponse> {
    const startedAt = Date.now();
    const handler = this.handlers[request.tool];
    if (!handler) {
      throw new AgentToolError({ code: "unsupported_tool", message: `Unsupported agent tool: ${request.tool}` });
    }

    try {
      const response = redactCredentials(await handler(request.arguments, context)) as AgentToolResponse;
      this.audit(request, context, startedAt, "ok", response);
      return response;
    } catch (error) {
      const normalized = normalizeAgentToolError(error, providerFor(request.tool));
      this.audit(request, context, startedAt, "error", null);
      throw normalized;
    }
  }

  private audit(
    request: AgentToolRequest,
    context: AgentToolExecutionContext,
    startedAt: number,
    status: AgentToolAuditRecord["status"],
    response: AgentToolResponse | null,
  ): void {
    const record: AgentToolAuditRecord = {
      taskId: context.taskId,
      runId: context.runId,
      tool: request.tool,
      resource: redactCredentials(response?.source.resource ?? normalizedResource(request)) as string,
      arguments: redactCredentials(request.arguments) as Record<string, unknown>,
      durationMs: Date.now() - startedAt,
      status,
      bytes: response?.bytes ?? null,
      pages: response?.pagination.pages ?? 0,
      truncated: response?.truncated ?? false,
    };
    this.onAudit?.(record);
    if (status === "ok") this.logger?.info(record, "agent tool completed");
    else this.logger?.warn(record, "agent tool failed");
  }
}

function providerFor(tool: AgentToolRequest["tool"]): "github" | "linear" | "slack" | "web" {
  if (tool.startsWith("github_")) return "github";
  if (tool === "linear_read") return "linear";
  if (tool === "slack_read") return "slack";
  return "web";
}

function normalizedResource(request: AgentToolRequest): string {
  const candidate = request.arguments.path ?? request.arguments.url ?? request.arguments.operation ?? request.arguments.workflow;
  return typeof candidate === "string" ? candidate : request.tool;
}
