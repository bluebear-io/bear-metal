import { createAppAuth } from "@octokit/auth-app";
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";

import type { JsonValue } from "../../json.js";
import type { CommentCapable, Integration } from "../base.js";
import type {
  CheckRun,
  FailedCheckRun,
  FailedStatus,
  IssueComment,
  PRState,
  PullRequest,
  PullRequestCommit,
  PullRequestContext,
  PullRequestRef,
  PullRequestStatus,
  ReviewThread,
} from "./types.js";

type OctokitPullListItem = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"][number];
type OctokitPull = RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];
type OctokitCheckRun = RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"][number];
type OctokitStatus = RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"]["statuses"][number];

export interface BotIdentity {
  login: string;
  id: string | null;
  numericId: number;
  /** Bot user's numeric REST ID — distinct from the App's numeric ID and used for commit matching. */
  userNumericId: number;
}

export interface GitHubIntegrationOptions {
  /** GitHub App credentials — the client authenticates as the installation. */
  appId: number;
  privateKey: string;
  installationId: number;
}

export class GitHubIntegration implements Integration, CommentCapable<PullRequestRef> {
  readonly name = "github";
  private readonly octokit: Octokit;
  private cachedBotIdentity: BotIdentity | null = null;

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

  async getInstallationToken(): Promise<string> {
    const auth = (await this.octokit.auth({ type: "installation" })) as { token: string };
    return auth.token;
  }

  async getBotLogin(): Promise<string> {
    return (await this.getBotIdentity()).login;
  }

  async getBotIdentity(): Promise<BotIdentity> {
    if (!this.cachedBotIdentity) {
      const { data } = await this.octokit.apps.getAuthenticated();
      if (!data) {
        throw new Error("GitHub API returned null for authenticated app");
      }
      const token = await this.getInstallationToken();
      const installationOctokit = new Octokit({ auth: token });
      const botLogin = `${data.slug}[bot]`;
      const [viewer, { data: user }] = await Promise.all([
        installationOctokit.graphql<{ viewer: { id: string | null } }>(
          "query BearMetalViewer { viewer { id } }",
        ),
        installationOctokit.request("GET /users/{username}", { username: botLogin }),
      ]);
      this.cachedBotIdentity = { login: botLogin, id: viewer.viewer.id, numericId: data.id, userNumericId: user.id };
    }
    return this.cachedBotIdentity;
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
    const { data } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return toPullRequest(data, ref.owner, ref.repo);
  }

  /** PR merge/close state plus the work signals the manager dispatches on. */
  async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    const [pr, context, commits, bearMetalIdentity] = await Promise.all([
      this.getPullRequest(ref),
      this.getPullRequestContext(ref),
      this.getPullRequestCommits(ref),
      this.getBotIdentity(),
    ]);
    return {
      pr,
      testsFailed: context.failedCheckRuns.length > 0 || context.failedStatuses.length > 0,
      hasActionableUnresolvedComments: context.unresolvedReviewThreads.some((thread) =>
        isActionableReviewThread(thread, bearMetalIdentity),
      ),
      hasActionableIssueComments: context.issueComments.length > 0,
      // GitHub returns null while it's still recomputing the merge after a push — don't trigger
      // re-dispatch on null, the next poll will see a definite value.
      hasMergeConflicts: context.mergeable === false,
      humanTookOver: isHumanTakeover(commits, bearMetalIdentity),
      context,
    };
  }

  /**
   * Commits on the PR head branch, oldest-first (the order GitHub returns).
   * Used by the scheduler to detect a human takeover — a non-bear-metal commit pushed after bear-metal's last one.
   */
  async getPullRequestCommits(ref: PullRequestRef): Promise<PullRequestCommit[]> {
    const commits: PullRequestCommit[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.pulls.listCommits({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        per_page: 100,
        page,
      });
      for (const commit of data) {
        commits.push({
          sha: commit.sha,
          author: commit.author ? { login: commit.author.login, id: commit.author.id } : null,
          committer: commit.committer ? { login: commit.committer.login, id: commit.committer.id } : null,
        });
      }
      if (data.length < 100) {
        break;
      }
      page += 1;
    }
    return commits;
  }

  async getPullRequestContext(ref: PullRequestRef): Promise<PullRequestContext> {
    const { data: pullRequest } = await this.octokit.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    const headSha = pullRequest.head.sha;

    const [failedCheckRuns, failedStatuses, reviewThreads, issueComments] = await Promise.all([
      this.getFailedCheckRuns(ref, headSha),
      this.getFailedStatuses(ref, headSha),
      this.getReviewThreads(ref),
      this.getActionableIssueComments(ref),
    ]);

    return {
      pullRequest: pullRequest as JsonValue,
      headSha,
      failedCheckRuns,
      failedStatuses,
      unresolvedReviewThreads: reviewThreads.filter((thread) => !thread.isResolved),
      reviewThreads,
      issueComments,
      completedIssueComments: [],
      // pullRequest.mergeable is typed `boolean | null | undefined`; normalize to boolean|null.
      mergeable: pullRequest.mergeable ?? null,
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

  /**
   * True if the PR already has an issue comment whose body contains `marker`. Used to keep
   * one-shot bot comments (e.g. the human-takeover handoff) idempotent across retries.
   */
  async hasIssueCommentWithMarker(ref: PullRequestRef, marker: string): Promise<boolean> {
    const iterator = this.octokit.paginate.iterator(this.octokit.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: 100,
    });
    for await (const { data: page } of iterator) {
      if (page.some((c) => typeof c.body === "string" && c.body.includes(marker))) return true;
    }
    return false;
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

  async listInstallationRepositories(): Promise<Array<{ owner: string; repo: string }>> {
    const repos: Array<{ owner: string; repo: string }> = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.apps.listReposAccessibleToInstallation({ per_page: 100, page });
      for (const repo of data.repositories) {
        repos.push({ owner: repo.owner.login, repo: repo.name });
      }
      if (data.repositories.length < 100) {
        break;
      }
      page += 1;
    }
    return repos;
  }

  async listPullRequestsForBranch(
    owner: string,
    repo: string,
    head: string,
    state: "all" | "open" | "closed" = "all",
  ): Promise<PullRequest[]> {
    const prs: PullRequest[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.pulls.list({
        owner,
        repo,
        head: `${owner}:${head}`,
        state,
        per_page: 100,
        page,
      });
      for (const pr of data) {
        prs.push(toPullRequest(pr, owner, repo));
      }
      if (data.length < 100) {
        break;
      }
      page += 1;
    }
    return prs;
  }

  async listCheckRunsForRef(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    const runs: CheckRun[] = [];
    let page = 1;
    while (true) {
      const { data } = await this.octokit.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 100,
        page,
      });
      for (const run of data.check_runs) {
        runs.push(toCheckRun(run));
      }
      if (data.check_runs.length < 100) {
        break;
      }
      page += 1;
    }
    return runs;
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

  private async getActionableIssueComments(ref: PullRequestRef): Promise<IssueComment[]> {
    const response = await this.octokit.graphql<IssueCommentsResponse>(ISSUE_COMMENTS_QUERY, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    });
    return response.repository.pullRequest.comments.nodes
      .filter((c) => !c.isMinimized)
      .map((c) => ({
        id: c.id,
        databaseId: c.databaseId,
        body: c.body,
        author: c.author?.login ?? null,
        authorId: c.author?.id ?? null,
        isMinimized: c.isMinimized,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
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

  private async getReviewThreads(ref: PullRequestRef): Promise<ReviewThread[]> {
    const response = await this.octokit.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
      owner: ref.owner,
      name: ref.repo,
      number: ref.number,
    });

    const threads = response.repository.pullRequest.reviewThreads.nodes;
    return threads
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
          authorId: comment.author?.id ?? null,
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

/**
 * A human takeover means bear-metal already pushed at least one commit to this branch AND the
 * latest commit on the branch is not bear-metal's — someone pushed after the agent and owns it now.
 * If bear-metal never pushed a commit, this returns false (nothing to take over from).
 */
export function isHumanTakeover(commits: PullRequestCommit[], bearMetal: BotIdentity | string): boolean {
  if (commits.length === 0) {
    return false;
  }
  // Numeric ID is more reliable than login when GitHub can't resolve the bot email.
  const isBearMetalCommit =
    typeof bearMetal !== "string"
      ? (commit: PullRequestCommit): boolean =>
          commit.author?.id === bearMetal.userNumericId || commit.committer?.id === bearMetal.userNumericId
      : (commit: PullRequestCommit): boolean =>
          commit.author?.login === bearMetal || commit.committer?.login === bearMetal;
  const firstBearMetalIdx = commits.findIndex(isBearMetalCommit);
  if (firstBearMetalIdx === -1) {
    return false;
  }
  return commits.slice(firstBearMetalIdx + 1).some((c) => !isBearMetalCommit(c));
}

export function isActionableReviewThread(thread: ReviewThread, bearMetal: BotIdentity | string): boolean {
  const latestComment = thread.comments.at(-1);
  if (!latestComment) {
    return true;
  }
  const bearMetalIdentity = typeof bearMetal === "string" ? { login: bearMetal, id: null } : bearMetal;
  if (latestComment.authorId && bearMetalIdentity.id) {
    return latestComment.authorId !== bearMetalIdentity.id;
  }
  return latestComment.author !== bearMetalIdentity.login;
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
    headSha: pull.head.sha,
    state: pull.state as PRState,
    draft: Boolean(pull.draft),
    merged: "merged" in pull ? pull.merged : pull.merged_at !== null,
    url: pull.html_url,
    createdAt: pull.created_at ?? null,
    updatedAt: pull.updated_at ?? null,
    mergedAt: pull.merged_at ?? null,
    closedAt: pull.closed_at ?? null,
  };
}

function toCheckRun(run: OctokitCheckRun): CheckRun {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.html_url ?? null,
    summary: run.output?.title ?? null,
    startedAt: run.started_at ?? null,
    completedAt: run.completed_at ?? null,
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
              author: { login: string; id?: string | null } | null;
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
                author {
                  login
                  ... on Node { id }
                }
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

type IssueCommentsResponse = {
  repository: {
    pullRequest: {
      comments: {
        nodes: Array<{
          id: string;
          databaseId: number;
          body: string;
          author: { login: string; id?: string | null } | null;
          isMinimized: boolean;
          createdAt: string;
          updatedAt: string;
        }>;
      };
    };
  };
};

const ISSUE_COMMENTS_QUERY = `
  query BearMetalIssueComments($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: 100) {
          nodes {
            id
            databaseId
            body
            author {
              login
              ... on Node { id }
            }
            isMinimized
            createdAt
            updatedAt
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
