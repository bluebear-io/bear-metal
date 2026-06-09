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
