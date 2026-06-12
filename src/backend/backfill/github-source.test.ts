import { describe, expect, it, vi } from "vitest";
import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";
import {
  type GitHubSource,
  loadCheckRunsForPullRequest,
  loadPullRequestsForBranch,
} from "./github-source.js";

const pr = (owner: string, repo: string, number: number, headRef: string): PullRequest => ({
  owner,
  repo,
  number,
  title: `PR ${number}`,
  headRef,
  headSha: `sha-${number}`,
  state: "open",
  draft: false,
  merged: false,
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
});

const run = (id: number, name: string): CheckRun => ({
  id,
  name,
  status: "completed",
  conclusion: "success",
  url: null,
  summary: null,
  startedAt: null,
  completedAt: null,
});

const makeSource = (overrides: Partial<GitHubSource> = {}): GitHubSource => ({
  listInstallationRepositories: vi.fn().mockResolvedValue([]),
  listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
  listCheckRunsForRef: vi.fn().mockResolvedValue([]),
  ...overrides,
});

describe("loadPullRequestsForBranch", () => {
  it("queries every repo and concatenates matches", async () => {
    const source = makeSource({
      listPullRequestsForBranch: vi
        .fn<GitHubSource["listPullRequestsForBranch"]>()
        .mockImplementation(async (owner, repo) => {
          if (owner === "a" && repo === "x") return [pr("a", "x", 1, "feature/foo")];
          if (owner === "b" && repo === "y") return [pr("b", "y", 2, "feature/foo")];
          return [];
        }),
    });

    const result = await loadPullRequestsForBranch(
      source,
      [
        { owner: "a", repo: "x" },
        { owner: "b", repo: "y" },
      ],
      "feature/foo",
    );

    expect(result).toHaveLength(2);
    expect(result.map((p) => `${p.owner}/${p.repo}#${p.number}`)).toEqual(["a/x#1", "b/y#2"]);
    expect(source.listPullRequestsForBranch).toHaveBeenCalledTimes(2);
  });

  it("returns an empty array when no repos match", async () => {
    const source = makeSource();
    const result = await loadPullRequestsForBranch(source, [{ owner: "a", repo: "x" }], "feature/none");
    expect(result).toEqual([]);
  });
});

describe("loadCheckRunsForPullRequest", () => {
  it("calls listCheckRunsForRef with the PR's head SHA", async () => {
    const source = makeSource({
      listCheckRunsForRef: vi.fn().mockResolvedValue([run(1, "lint")]),
    });
    const result = await loadCheckRunsForPullRequest(source, pr("a", "x", 1, "feature/foo"));
    expect(source.listCheckRunsForRef).toHaveBeenCalledWith("a", "x", "sha-1");
    expect(result).toHaveLength(1);
  });
});
