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
  /**
   * ISO timestamps populated by `GitHubIntegration` for PRs returned from the API. Optional so
   * test fixtures don't need to fill them in — only callers that need historical context (e.g.
   * the backfill tool) read these.
   */
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
}

/** Lean check-run shape mapped from the Octokit REST response at the integration boundary. */
export interface CheckRun {
  id: number;
  name: string;
  /** GitHub's check-run status field — "queued" / "in_progress" / "completed". */
  status: string;
  /** GitHub's check-run conclusion when completed (null while in_progress). */
  conclusion: string | null;
  /** Link to the run in the GitHub UI. */
  url: string | null;
  /** First-line summary of the result, when the check provides one. */
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** Enough to locate a PR for follow-up calls (get, comment). */
export type PullRequestRef = Pick<PullRequest, "owner" | "repo" | "number">;

/** A PR plus the signals the manager uses to decide whether to re-dispatch it. */
export interface PullRequestStatus {
  pr: PullRequest;
  /** Any failed check run or commit status on the head commit. */
  testsFailed: boolean;
  /** Any unresolved review thread whose latest comment is not from bear-metal. */
  hasActionableUnresolvedComments: boolean;
  /** Full granular context (failed checks + every review thread) — fed into the dashboard. */
  context: PullRequestContext;
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
  /** PR head commit SHA — used to key CI runs idempotently. */
  headSha: string;
  failedCheckRuns: FailedCheckRun[];
  failedStatuses: FailedStatus[];
  /** Subset of `reviewThreads` where isResolved=false — kept for back-compat with worker callers. */
  unresolvedReviewThreads: ReviewThread[];
  /** Every review thread on the PR, resolved or not, so the dashboard can render the full conversation. */
  reviewThreads: ReviewThread[];
}
