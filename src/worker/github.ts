import type {
  FailedCheckRun,
  FailedStatus,
  JsonValue,
  PullRequestContext,
  PullRequestRef,
  ReviewThread,
} from "./types.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export class GitHubClient {
  constructor(private readonly token: string) {}

  async getPullRequestContext(pr: PullRequestRef): Promise<PullRequestContext> {
    const pullRequest = await this.rest<JsonValue>("GET", `/repos/${pr.org}/${pr.repo}/pulls/${pr.number}`);
    const headSha = readHeadSha(pullRequest);

    const [failedCheckRuns, failedStatuses, unresolvedReviewThreads] = await Promise.all([
      this.getFailedCheckRuns(pr, headSha),
      this.getFailedStatuses(pr, headSha),
      this.getUnresolvedReviewThreads(pr),
    ]);

    return { pullRequest, failedCheckRuns, failedStatuses, unresolvedReviewThreads };
  }

  async createPullRequest(input: {
    org: string;
    repo: string;
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullRequestRef> {
    const pr = await this.rest<{ number: number }>("POST", `/repos/${input.org}/${input.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    });
    return { org: input.org, repo: input.repo, number: String(pr.number) };
  }

  async getDefaultBranch(org: string, repo: string): Promise<string> {
    const repository = await this.rest<{ default_branch?: string }>("GET", `/repos/${org}/${repo}`);
    if (!repository.default_branch) {
      throw new Error(`GitHub repository ${org}/${repo} did not return default_branch`);
    }
    return repository.default_branch;
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  }

  async replyToReviewThread(pr: PullRequestRef, threadId: string, body: string, threads: ReviewThread[]): Promise<void> {
    const thread = threads.find((candidate) => candidate.id === threadId);
    const commentId = thread?.comments[0]?.databaseId;
    if (!commentId) {
      throw new Error(`Could not find a REST review comment id for thread ${threadId}`);
    }
    await this.rest("POST", `/repos/${pr.org}/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`, { body });
  }

  private async getFailedCheckRuns(pr: PullRequestRef, sha: string): Promise<FailedCheckRun[]> {
    const response = await this.rest<{
      check_runs?: JsonValue[];
    }>("GET", `/repos/${pr.org}/${pr.repo}/commits/${sha}/check-runs?per_page=100`);
    const checkRuns = response.check_runs ?? [];
    const failed = checkRuns.filter(isFailedCheckRun);
    return Promise.all(
      failed.map(async (checkRun) => ({
        checkRun,
        annotations: await this.getCheckRunAnnotations(pr, readCheckRunId(checkRun)),
      })),
    );
  }

  private async getCheckRunAnnotations(pr: PullRequestRef, checkRunId: number): Promise<JsonValue[]> {
    return this.rest<JsonValue[]>(
      "GET",
      `/repos/${pr.org}/${pr.repo}/check-runs/${checkRunId}/annotations?per_page=100`,
    );
  }

  private async getFailedStatuses(pr: PullRequestRef, sha: string): Promise<FailedStatus[]> {
    const response = await this.rest<{ statuses?: JsonValue[] }>(
      "GET",
      `/repos/${pr.org}/${pr.repo}/commits/${sha}/status`,
    );
    return (response.statuses ?? []).filter(isFailedStatus).map((status) => ({ status }));
  }

  private async getUnresolvedReviewThreads(pr: PullRequestRef): Promise<ReviewThread[]> {
    const response = await this.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
      owner: pr.org,
      name: pr.repo,
      number: Number.parseInt(pr.number, 10),
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

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`GitHub API error ${response.status} ${method} ${path}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GitHub GraphQL error ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new Error("GitHub GraphQL response did not include data");
    }
    return payload.data;
  }
}

function readHeadSha(pullRequest: JsonValue): string {
  if (!isRecord(pullRequest) || !isRecord(pullRequest.head) || typeof pullRequest.head.sha !== "string") {
    throw new Error("GitHub pull request response did not include head.sha");
  }
  return pullRequest.head.sha;
}

function readCheckRunId(checkRun: JsonValue): number {
  if (!isRecord(checkRun) || typeof checkRun.id !== "number") {
    throw new Error("GitHub check run response did not include numeric id");
  }
  return checkRun.id;
}

function isFailedCheckRun(checkRun: JsonValue): boolean {
  if (!isRecord(checkRun)) {
    return false;
  }
  if (checkRun.status !== "completed") {
    return false;
  }
  return !["success", "neutral", "skipped"].includes(String(checkRun.conclusion));
}

function isFailedStatus(status: JsonValue): boolean {
  return isRecord(status) && status.state !== "success";
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
