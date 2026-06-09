import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";

import type { CommentCapable, Integration } from "../base.js";
import type { Ticket } from "../linear/types.js";
import type { PRState, PullRequest } from "./types.js";

type OctokitPullListItem = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];
type OctokitPull = RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];

export interface GitHubIntegrationOptions {
  token: string;
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
export class GitHubIntegration implements Integration, CommentCapable<number> {
  readonly name = "github";
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(options: GitHubIntegrationOptions) {
    this.octokit = new Octokit({ auth: options.token });
    this.owner = options.owner;
    this.repo = options.repo;
  }

  /** Find the open PR whose head branch refers to the ticket, or null if none. */
  async findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null> {
    const pulls = await this.octokit.paginate(this.octokit.pulls.list, {
      owner: this.owner,
      repo: this.repo,
      state: "open",
      per_page: 100,
    });
    const match = pulls.find((pull) => branchMatchesTicket(pull.head.ref, ticket));
    return match ? toPullRequest(match) : null;
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return toPullRequest(data);
  }

  async leaveComment(prNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body,
    });
  }
}

function toPullRequest(pull: OctokitPullListItem | OctokitPull): PullRequest {
  return {
    number: pull.number,
    title: pull.title,
    headRef: pull.head.ref,
    state: pull.state as PRState,
    draft: Boolean(pull.draft),
    merged: "merged" in pull ? pull.merged : pull.merged_at !== null,
    url: pull.html_url,
  };
}
