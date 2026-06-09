import type { LinearTicketContext, PullRequestContext, PullRequestRef, ReviewThread } from "../shared/index.js";

export interface WorkerDatabase {
  recordTaskInProgress(ticketId: string): Promise<void>;
}

export type DispatchState = "new" | "iteration";

export type DispatchResult = {
  status: "pending" | "done";
  pr: PullRequestRef | null;
};

export type { PullRequestRef };

export interface WorkerGitHub {
  getPullRequestContext(pr: PullRequestRef): Promise<PullRequestContext>;
  resolveReviewThread(threadId: string): Promise<void>;
  replyToReviewThread(pr: PullRequestRef, threadId: string, body: string, threads: ReviewThread[]): Promise<void>;
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

export interface WorkerLinear {
  getTicketContext(ticketId: string): Promise<LinearTicketContext>;
  commentAndAssignToCreator(ticketId: string, body: string): Promise<void>;
}

export type WorkerIntegrations = {
  github: WorkerGitHub;
  linear: WorkerLinear;
  database: WorkerDatabase;
};

export type CloneScriptResult = {
  scriptPath: string;
  workspaceDir: string;
  stdout: string;
  stderr: string;
};

export type WorkerInputContext = {
  state: DispatchState;
  ticketId: string;
  pr: PullRequestRef | null;
  ticket: LinearTicketContext;
  pullRequest: PullRequestContext | null;
  cloneScript: CloneScriptResult;
};
