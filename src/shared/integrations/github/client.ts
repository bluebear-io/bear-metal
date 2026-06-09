import { createAppAuth } from "@octokit/auth-app";
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";

import type { JsonValue } from "../../json.js";
import type { CommentCapable, Integration } from "../base.js";
import type { Ticket } from "../linear/types.js";
import type {
  FailedCheckRun,
  FailedStatus,
  PRState,
  PullRequest,
  PullRequestContext,
  PullRequestRef,
  ReviewThread,
} from "./types.js";

type OctokitPullListItem = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];
type OctokitPull = RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];
type OctokitCheckRun = RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"][number];
type OctokitStatus = RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"]["statuses"][number];

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

  async getPullRequestContext(ref: PullRequestRef): Promise<PullRequestContext> {
    const { data: pullRequest } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    const headSha = pullRequest.head.sha;

    const [failedCheckRuns, failedStatuses, unresolvedReviewThreads] = await Promise.all([
      this.getFailedCheckRuns(ref, headSha),
      this.getFailedStatuses(ref, headSha),
      this.getUnresolvedReviewThreads(ref),
    ]);

    return {
      pullRequest: pullRequest as JsonValue,
      failedCheckRuns,
      failedStatuses,
      unresolvedReviewThreads,
    };
  }

  async leaveComment(ref: PullRequestRef, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body,
    });
  }

  async createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullRequestRef> {
    const { data } = await this.octokit.pulls.create({
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    });
    return { owner: input.owner, repo: input.repo, number: data.number };
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const { data } = await this.octokit.repos.get({ owner, repo });
    return data.default_branch;
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.octokit.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  }

  async replyToReviewThread(ref: PullRequestRef, threadId: string, body: string, threads: ReviewThread[]): Promise<void> {
    const thread = threads.find((candidate) => candidate.id === threadId);
    const commentId = thread?.comments[0]?.databaseId;
    if (!commentId) {
      throw new Error(`Could not find a REST review comment id for thread ${threadId}`);
    }
    await this.octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
      {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        comment_id: commentId,
        body,
      },
    );
  }

  /** Every repo the App installation can access. */
  private async installationRepos(): Promise<RepoCoords[]> {
    const repos = await this.octokit.paginate(
      this.octokit.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repos.map((repo) => ({ owner: repo.owner.login, repo: repo.name }));
  }

  private async getFailedCheckRuns(ref: PullRequestRef, sha: string): Promise<FailedCheckRun[]> {
    const { data } = await this.octokit.checks.listForRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: sha,
      per_page: 100,
    });
    const failed = data.check_runs.filter(isFailedCheckRun);
    return Promise.all(
      failed.map(async (checkRun) => ({
        checkRun: checkRun as JsonValue,
        annotations: await this.getCheckRunAnnotations(ref, checkRun.id),
      })),
    );
  }

  private async getCheckRunAnnotations(ref: PullRequestRef, checkRunId: number): Promise<JsonValue[]> {
    const { data } = await this.octokit.checks.listAnnotations({
      owner: ref.owner,
      repo: ref.repo,
      check_run_id: checkRunId,
      per_page: 100,
    });
    return data as JsonValue[];
  }

  private async getFailedStatuses(ref: PullRequestRef, sha: string): Promise<FailedStatus[]> {
    const { data } = await this.octokit.repos.getCombinedStatusForRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: sha,
    });
    return data.statuses.filter(isFailedStatus).map((status) => ({ status: status as JsonValue }));
  }

  private async getUnresolvedReviewThreads(ref: PullRequestRef): Promise<ReviewThread[]> {
    const response = await this.octokit.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    });

    const threads = response.repository.pullRequest.reviewThreads.nodes;
    return threads
      .filter((thread) => !thread.isResolved)
      .map((thread) => ({
        id: thread.id,
        isResolved: thread.isResolved,
        path: thread.path ?? null,
        line: thread.line ?? null,
        comments: thread.comments.nodes.map((comment) => ({
          id: comment.id,
          databaseId: comment.databaseId,
          body: comment.body,
          author: comment.author?.login ?? null,
          url: comment.url,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          path: comment.path ?? null,
          line: comment.line ?? null,
          originalLine: comment.originalLine ?? null,
          diffHunk: comment.diffHunk ?? null,
        })),
      }));
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

function isFailedCheckRun(checkRun: OctokitCheckRun): boolean {
  if (checkRun.status !== "completed") {
    return false;
  }
  return !["success", "neutral", "skipped"].includes(String(checkRun.conclusion));
}

function isFailedStatus(status: OctokitStatus): boolean {
  return status.state !== "success";
}

type ReviewThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path?: string | null;
          line?: number | null;
          comments: {
            nodes: Array<{
              id: string;
              databaseId: number | null;
              body: string;
              author: { login: string } | null;
              url: string;
              createdAt: string;
              updatedAt: string;
              path?: string | null;
              line?: number | null;
              originalLine?: number | null;
              diffHunk?: string | null;
            }>;
          };
        }>;
      };
    };
  };
};

const REVIEW_THREADS_QUERY = `
  query BearMetalReviewThreads($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                author { login }
                url
                createdAt
                updatedAt
                path
                line
                originalLine
                diffHunk
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation BearMetalResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;
