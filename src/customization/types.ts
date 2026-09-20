export const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOKENS = 20_000_000;
export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_DATABASE_URL = "sqlite:./data/bear-metal.sqlite";
export const WORKSPACE_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export type LlmProvider = "anthropic" | "openai" | "google" | "amazon-bedrock";

export type SecretGetter = () => string | Promise<string>;

export interface BearMetalConfig {
  linear: {
    clientId: string;
    oauthScopes?: string;
    getClientSecret: SecretGetter;
  };
  github: {
    appId: number;
    installationId: number;
    getPrivateKey: SecretGetter;
  };
  slack?: {
    notificationChannel: string;
    getBotToken: SecretGetter;
  };
  database?: {
    getUrl: SecretGetter;
  };
  maxIterations?: number;
  llmProviders: Partial<{
    anthropic: { getApiKey: SecretGetter };
    openai: { getApiKey: SecretGetter };
    google: { getApiKey: SecretGetter };
  }>;
  customizeTask: (task: Task) => TaskCustomization | Promise<TaskCustomization>;
}

export type TaskStatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled";
export type TaskPriority = "none" | "urgent" | "high" | "medium" | "low";

export interface Task {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly status: Readonly<{ name: string; category: TaskStatusCategory }>;
  readonly priority: TaskPriority;
  readonly labels: readonly string[];
  readonly project: Readonly<{ id: string; name: string }> | null;
  readonly assignee: Readonly<{ id: string; name: string | null; email: string | null }> | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
  readonly canceledAt: string | null;
  readonly comments: readonly TaskComment[];
  readonly attachments: readonly TaskAttachment[];
  readonly relations: readonly TaskRelation[];
  readonly repositories: readonly Repository[];
  readonly run: Readonly<{ kind: "new" | "iteration"; iteration: number }>;
  readonly pullRequests: readonly TaskPullRequest[];
}

export interface TaskComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly author: Readonly<{ id: string; name: string; email: string }> | null;
}

export interface TaskAttachment { readonly id: string; readonly title: string; readonly url: string }
export interface TaskRelation { readonly type: string; readonly taskIdentifier: string }
export interface Repository { readonly owner: string; readonly name: string }

export interface TaskPullRequest {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly mergeable: boolean | null;
  readonly failedChecks: readonly Readonly<{ name: string; status: string; conclusion: string | null; url: string | null }>[];
  readonly comments: readonly Readonly<{ id: string; body: string; author: string | null; url: string | null; createdAt: string; updatedAt: string }>[];
  readonly reviewThreads: readonly Readonly<{ id: string; resolved: boolean; path: string | null; line: number | null; comments: readonly TaskPullRequest["comments"][number][] }>[];
}

export interface TaskCustomization {
  llm: { provider: LlmProvider; model: string };
  buildWorkspace: (input: Readonly<{ workspacePath: string; signal: AbortSignal }>) => Promise<void>;
  additionalSystemPrompt?: string | null;
  limits?: { maxDurationMs?: number; maxTokens?: number };
}

export interface ResolvedLlm {
  provider: LlmProvider;
  model: string;
  apiKey: string | null;
}
