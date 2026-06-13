import type {
  LinearTicketContext,
  PullRequestContext,
  PullRequestRef,
  PullRequestNotification,
  ReviewThread,
  BotIdentity,
} from "../shared/index.js";

export type DispatchState = "new" | "iteration";

/** LLM usage stats from the pi agent session, surfaced for cost/efficacy analytics (DEN-2313). */
export interface DispatchUsage {
  promptTokens: number;
  completionTokens: number;
  modelName: string;
  provider: string;
}

/**
 * One step of the agent's tool-call timeline (DEN-2311). Captured from the pi session
 * transcript at run end so the dashboard can render a thought-process tree.
 */
export interface DispatchToolCall {
  /** Stable id matching the assistant `tool_use` block id when available, otherwise synthesized. */
  id: string;
  /** 0-based position within the run. */
  sequence: number;
  toolName: string;
  /** JSON-stringified tool input. */
  argsJson: string;
  /** JSON-stringified or plain-text tool result body. Null if the run aborted before a result arrived. */
  resultText: string | null;
  resultStatus: "ok" | "error" | "unknown" | null;
  /** Character length of the untruncated `resultText`. */
  outputSize: number | null;
  /** Assistant text that preceded the tool_use block in the same turn. */
  thoughtText: string | null;
  /** ms-since-epoch when this step was recorded from the transcript. */
  createdAt: number;
}

export type DispatchResult = {
  status: "pending" | "done";
  prs: PullRequestRef[];
  usage?: DispatchUsage;
  /** Ordered tool-call timeline for the run; empty when no tool calls were captured. */
  toolCalls?: DispatchToolCall[];
  /** When true, fire a Slack DM once the ticket reaches waiting_for_human (set by push_for_review). */
  notifyOnComplete?: boolean;
};

export type { PullRequestRef };

export interface WorkerGitHub {
  getInstallationToken(): Promise<string>;
  getBotIdentity(): Promise<BotIdentity>;
  getPullRequestContext(pr: PullRequestRef): Promise<PullRequestContext>;
  resolveReviewThread(threadId: string): Promise<void>;
  replyToReviewThread(pr: PullRequestRef, threadId: string, body: string, threads: ReviewThread[]): Promise<void>;
  leaveComment(pr: PullRequestRef, body: string): Promise<void>;
  getDefaultBranch(owner: string, repo: string): Promise<string>;
  createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullRequestRef>;
}

export interface WorkerCommentStore {
  markCompleted(pr: PullRequestRef, commentId: string): Promise<void>;
  getCompleted(pr: PullRequestRef): Promise<Set<string>>;
}

export interface WorkerSlack {
  notifyPullRequest(notification: PullRequestNotification): Promise<void>;
}

export interface WorkerLinear {
  getTicketContext(ticketId: string): Promise<LinearTicketContext>;
  moveTicketToInProgress(ticketId: string): Promise<void>;
  moveTicketToInReview(ticketId: string): Promise<void>;
  commentAndHandBack(ticketId: string, body: string): Promise<void>;
  getUserEmail(userId: string): Promise<string | null>;
}

export type WorkerIntegrations = {
  github: WorkerGitHub;
  linear: WorkerLinear;
  /** Optional — when unset, PR notifications are skipped. */
  slack?: WorkerSlack;
  /** Optional — when unset, completed issue comment filtering is skipped. */
  commentStore?: WorkerCommentStore;
};

export type CloneScriptResult = {
  scriptPath: string;
  workspaceDir: string;
  stdout: string;
  stderr: string;
  /** Absolute path to a private temp dir containing .netrc with GitHub token.
   *  Caller is responsible for deleting it after the dispatch completes. */
  netrcDir: string;
};

export type WorkerInputContext = {
  state: DispatchState;
  ticketId: string;
  prs: PullRequestRef[];
  ticket: LinearTicketContext;
  pullRequests: PullRequestContext[];
  cloneScript: CloneScriptResult;
};
