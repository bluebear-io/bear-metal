import { createAppAuth } from "@octokit/auth-app";
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";

import type { CommentCapable, Integration } from "../base.js";
import type { Ticket } from "../linear/types.js";
import type { PRState, PullRequest, PullRequestRef } from "./types.js";

type OctokitPullListItem = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];
type OctokitPull = RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];

export interface GitHubIntegrationOptions {
  /** GitHub App credentials — the client authenticates as the installation. */
  appId: number;
  privateKey: string;
  installationId: number;
}

interface RepoCoords {
  owner: string;
  repo: string;
}

/** True when a PR head branch refers to the given ticket (case-insensitive substring). */
export function branchMatchesTicket(
  headRef: string,
  ticket: Pick<Ticket, "identifier" | "branchName">,
): boolean {
  const ref = headRef.toLowerCase();
  return (
    ref.includes(ticket.identifier.toLowerCase()) ||
    ref.includes(ticket.branchName.toLowerCase())
  );
}

/** GitHub integration. Extend with more capabilities (merge, review, ...) as needed. */
export class GitHubIntegration implements Integration, CommentCapable<PullRequestRef> {
  readonly name = "github";
  private readonly octokit: Octokit;

  constructor(options: GitHubIntegrationOptions) {
    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: options.appId,
        privateKey: options.privateKey,
        installationId: options.installationId,
      },
    });
  }

  /**
   * Find the open PR whose head branch refers to the ticket, across every repo the
   * App installation can access. Returns null if none. (GitHub is queried only for
   * active tickets, so the per-repo scan stays cheap.)
   */
  async findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null> {
    for (const { owner, repo } of await this.installationRepos()) {
      const pulls = await this.octokit.paginate(this.octokit.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      const match = pulls.find((pull) => branchMatchesTicket(pull.head.ref, ticket));
      if (match) {
        return toPullRequest(match, owner, repo);
      }
    }
    return null;
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return toPullRequest(data, ref.owner, ref.repo);
  }

  async leaveComment(ref: PullRequestRef, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body,
    });
  }

  /** Every repo the App installation can access. */
  private async installationRepos(): Promise<RepoCoords[]> {
    const repos = await this.octokit.paginate(
      this.octokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repos.map((repo) => ({ owner: repo.owner.login, repo: repo.name }));
  }
}

function toPullRequest(
  pull: OctokitPullListItem | OctokitPull,
  owner: string,
  repo: string,
): PullRequest {
  return {
    owner,
    repo,
    number: pull.number,
    title: pull.title,
    headRef: pull.head.ref,
    state: pull.state as PRState,
    draft: Boolean(pull.draft),
    merged: "merged" in pull ? pull.merged : pull.merged_at !== null,
    url: pull.html_url,
  };
}
