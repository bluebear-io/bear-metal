import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";

/**
 * The slice of `GitHubIntegration` the backfill enrichment needs. Stating it as an interface lets
 * tests inject a fake without instantiating an Octokit client.
 */
export interface GitHubSource {
  listInstallationRepositories(): Promise<Array<{ owner: string; repo: string }>>;
  listPullRequestsForBranch(
    owner: string,
    repo: string,
    head: string,
    state?: "all" | "open" | "closed",
  ): Promise<PullRequest[]>;
  listCheckRunsForRef(owner: string, repo: string, ref: string): Promise<CheckRun[]>;
}

/** Walk every repo the App can access and return PRs whose head branch matches `branchName`. */
export async function loadPullRequestsForBranch(
  source: GitHubSource,
  repos: Array<{ owner: string; repo: string }>,
  branchName: string,
): Promise<PullRequest[]> {
  const prs: PullRequest[] = [];
  for (const { owner, repo } of repos) {
    const found = await source.listPullRequestsForBranch(owner, repo, branchName);
    prs.push(...found);
  }
  return prs;
}

/**
 * Every check run on a PR's head commit. Historical PR branches may be deleted, so branch names are
 * not stable enough for this lookup.
 */
export async function loadCheckRunsForPullRequest(
  source: GitHubSource,
  pr: PullRequest,
): Promise<CheckRun[]> {
  return source.listCheckRunsForRef(pr.owner, pr.repo, pr.headSha);
}
