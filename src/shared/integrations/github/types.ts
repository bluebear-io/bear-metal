export type PRState = "open" | "closed";

/**
 * Lean GitHub pull-request contract. Mapped from the Octokit REST response at the
 * integration boundary so the rest of the codebase never sees raw Octokit shapes.
 */
export interface PullRequest {
  number: number;
  title: string;
  /** Head branch name. */
  headRef: string;
  state: PRState;
  draft: boolean;
  merged: boolean;
  url: string;
}
