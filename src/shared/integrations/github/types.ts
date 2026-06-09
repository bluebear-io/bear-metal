import type { JsonValue } from "../../json.js";

export type PRState = "open" | "closed";

/**
 * Lean GitHub pull-request contract. Mapped from the Octokit REST response at the
 * integration boundary so the rest of the codebase never sees raw Octokit shapes.
 */
export interface PullRequest {
  /** Repo this PR lives in — the agent scans every repo the App installation can access. */
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** Head branch name. */
  headRef: string;
  state: PRState;
  draft: boolean;
  merged: boolean;
  url: string;
}

/** Enough to locate a PR for follow-up calls (get, comment). */
export type PullRequestRef = Pick<PullRequest, "owner" | "repo" | "number">;

/** A PR plus the signals the manager uses to decide whether to re-dispatch it. */
export interface PullRequestStatus {
  pr: PullRequest;
  /** Any failed check run or commit status on the head commit. */
  testsFailed: boolean;
  /** Any unresolved review thread. */
  hasUnresolvedComments: boolean;
}

export interface FailedCheckRun {
  checkRun: JsonValue;
  annotations: JsonValue[];
}

export interface FailedStatus {
  status: JsonValue;
}

export interface ReviewThreadComment {
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
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface PullRequestContext {
  pullRequest: JsonValue;
  failedCheckRuns: FailedCheckRun[];
  failedStatuses: FailedStatus[];
  unresolvedReviewThreads: ReviewThread[];
}
