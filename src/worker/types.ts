export type DispatchState = "new" | "iteration";

export type PullRequestRef = {
  org: string;
  repo: string;
  number: string;
};

export type DispatchResult = {
  status: "pending" | "done";
  pr: PullRequestRef | null;
};

export type WorkerConfig = {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  linearApiToken: string;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type TicketContext = {
  issue: JsonValue;
  comments: JsonValue[];
};

export type FailedCheckRun = {
  checkRun: JsonValue;
  annotations: JsonValue[];
};

export type FailedStatus = {
  status: JsonValue;
};

export type ReviewThreadComment = {
  id: string;
  databaseId: number | null;
  body: string;
  author: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
};

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
};

export type PullRequestContext = {
  pullRequest: JsonValue;
  failedCheckRuns: FailedCheckRun[];
  failedStatuses: FailedStatus[];
  unresolvedReviewThreads: ReviewThread[];
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
  ticket: TicketContext;
  pullRequest: PullRequestContext | null;
  cloneScript: CloneScriptResult;
};
