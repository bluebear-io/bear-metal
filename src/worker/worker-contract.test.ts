import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../shared/index.js";
import { buildWorkerPrompt } from "./prompts.js";
import { validateDispatchInputs } from "./dispatch.js";
import type { WorkerInputContext } from "./types.js";

describe("worker contract", () => {
  it("rejects iteration without PR", () => {
    expect(() => validateDispatchInputs("iteration", "DEN-1", null)).toThrow(/requires a pull request/);
  });

  it("rejects new state with PR", () => {
    expect(() =>
      validateDispatchInputs("new", "DEN-1", { owner: "bluebear-io", repo: "bear-metal", number: 1 }),
    ).toThrow(/must not include a pull request/);
  });

  it("accepts ssh and https remotes", () => {
    expect(parseGitHubRemote("git@github.com:bluebear-io/bear-metal.git")).toEqual({
      owner: "bluebear-io",
      repo: "bear-metal",
    });
    expect(parseGitHubRemote("https://github.com/Blue-Bear-Security/handler.git")).toEqual({
      owner: "Blue-Bear-Security",
      repo: "handler",
    });
  });

  it("builds state-specific iteration instructions", () => {
    const context: WorkerInputContext = {
      state: "iteration",
      ticketId: "DEN-1",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 7 },
      ticket: {
        issue: {
          id: "issue-id",
          identifier: "DEN-1",
          title: "Fix thing",
          description: null,
          url: "https://linear.app/bluebear/issue/DEN-1/fix-thing",
          branchName: "feature/den-1-fix-thing",
          status: { name: "Todo", type: "unstarted" },
          labels: ["bear-metal"],
          assignee: { id: "creator" },
          delegate: { id: "user-1" },
        },
        comments: [],
      },
      pullRequest: {
        pullRequest: { number: 7 },
        headSha: "deadbeef",
        failedCheckRuns: [],
        failedStatuses: [],
        unresolvedReviewThreads: [],
        reviewThreads: [],
      },
      cloneScript: {
        scriptPath: "/tmp/script.sh",
        workspaceDir: "/tmp/workspace",
        stdout: "",
        stderr: "",
      },
    };

    const prompt = buildWorkerPrompt(context);
    expect(prompt).toMatch(/Steps for this PR iteration/);
    expect(prompt).toMatch(/agree_with_github_message/);
    expect(prompt).toMatch(/Never read, write, search, or cd outside the repository root/);
    expect(prompt).toMatch(/DEN-1/);
  });
});
