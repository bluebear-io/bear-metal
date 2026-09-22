export type AgentToolName = "github_read" | "linear_read" | "slack_read" | "web_get" | "github_dispatch";

export type AgentToolProvider = "github" | "linear" | "slack" | "web";

export type AgentToolRequest = {
  tool: AgentToolName;
  arguments: Record<string, unknown>;
};

export type AgentToolExecutionContext = {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
};

export type AgentToolResponse = {
  source: {
    provider: AgentToolProvider;
    resource: string;
  };
  data?: unknown;
  errors?: unknown;
  artifact?: {
    path: string;
    contentType: string;
    byteCount: number;
  };
  pagination: {
    pages: number;
    hasMore: boolean;
    next?: string;
  };
  bytes: {
    compressed: number;
    decompressed: number;
    returned: number;
  };
  truncated: boolean;
  truncationReason?: "model_limit" | "page_limit" | "response_limit";
};

export type AgentToolAuditRecord = {
  taskId: string;
  runId: string;
  tool: AgentToolName;
  resource: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  status: "ok" | "error";
  bytes: AgentToolResponse["bytes"] | null;
  pages: number;
  truncated: boolean;
};

export type AgentToolHandler = (
  args: Record<string, unknown>,
  context: AgentToolExecutionContext,
) => Promise<AgentToolResponse>;

export type AgentToolHandlers = Partial<Record<AgentToolName, AgentToolHandler>>;

export interface AgentToolGatewayLike {
  availableTools(): readonly AgentToolName[];
  execute(request: AgentToolRequest, context: AgentToolExecutionContext): Promise<AgentToolResponse>;
}

export class AgentToolError extends Error {
  readonly code: string;
  readonly provider?: AgentToolProvider;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(input: {
    code: string;
    message: string;
    provider?: AgentToolProvider;
    retryable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentToolError";
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable ?? false;
    this.status = input.status;
  }
}
