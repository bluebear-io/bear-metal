import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../shared/index.js";
import { buildWorkerPrompt } from "./prompts.js";
import { validateDispatchInputs } from "./dispatch.js";
import type { WorkerInputContext } from "./types.js";

describe("worker contract", () => {
  it("rejects iteration without PR", () => {
    expect(() => validateDispatchInputs("iteration", "DEN-1", [])).toThrow(/requires at least one pull request/);
  });

  it("rejects new state with PR", () => {
    expect(() =>
      validateDispatchInputs("new", "DEN-1", [{ owner: "bluebear-io", repo: "bear-metal", number: 1 }]),
    ).toThrow(/must not include any pull requests/);
  });

  it("accepts ssh and https remotes", () => {
    expect(parseGitHubRemote("git@github.com:bluebear-io/bear-metal.git")).toEqual({
      owner: "bluebear-io",
      repo: "bear-metal",
    });
    expect(parseGitHubRemote("https://github.com/bluebear-io/handler.git")).toEqual({
      owner: "bluebear-io",
      repo: "handler",
    });
  });

  it("builds state-specific iteration instructions and excludes respond_to_ticket_reporter", () => {
    const context: WorkerInputContext = {
      state: "iteration",
      ticketId: "DEN-1",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 7 }],
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
          teamKey: "DEN",
          assignee: { id: "creator" },
          delegate: { id: "user-1" },
          priority: 0,
        },
        comments: [],
      },
      pullRequests: [
        {
          pullRequest: { number: 7 },
          headSha: "deadbeef",
          failedCheckRuns: [],
          failedStatuses: [],
          unresolvedReviewThreads: [],
          reviewThreads: [],
          issueComments: [],
          mergeable: true,
        },
      ],
      cloneScript: {
        agentWorkdir: "/tmp/workspace/agent",
        workspaceDir: "/tmp/workspace",
        stdout: "",
        stderr: "",
        netrcDir: "/tmp/netrc",
      },
    };

    const prompt = buildWorkerPrompt(context);
    expect(prompt).toMatch(/Steps for this PR iteration/);
    expect(prompt).toMatch(/agree_with_github_message/);
    expect(prompt).toMatch(/disagree_with_github_message/);
    expect(prompt).toMatch(/respond_to_comment_writer/);
    expect(prompt).toMatch(/mark_github_message_completed/);
    expect(prompt).toMatch(/openComments/);
    expect(prompt).toMatch(/Never read, write, search, or cd outside the repository root/);
    expect(prompt).toMatch(/DEN-1/);
    expect(prompt).not.toMatch(/respond_to_ticket_reporter/);
  });

  it("builds state-specific new task instructions with respond_to_ticket_reporter", () => {
    const context: WorkerInputContext = {
      state: "new",
      ticketId: "DEN-2",
      prs: [],
      ticket: {
        issue: {
          id: "issue-id",
          identifier: "DEN-2",
          title: "New thing",
          description: null,
          url: "https://linear.app/bluebear/issue/DEN-2/new-thing",
          branchName: "feature/den-2-new-thing",
          status: { name: "Todo", type: "unstarted" },
          labels: ["bear-metal"],
          teamKey: "DEN",
          assignee: { id: "creator" },
          delegate: { id: "user-1" },
          priority: 0,
        },
        comments: [],
      },
      pullRequests: [],
      cloneScript: {
        agentWorkdir: "/tmp/workspace/agent",
        workspaceDir: "/tmp/workspace",
        stdout: "",
        stderr: "",
        netrcDir: "/tmp/netrc",
      },
    };

    const prompt = buildWorkerPrompt(context);
    expect(prompt).toMatch(/Steps for this new task/);
    expect(prompt).toMatch(/respond_to_ticket_reporter/);
    expect(prompt).toMatch(/push_for_review/);
    expect(prompt).not.toMatch(/respond_to_comment_writer/);
    expect(prompt).not.toMatch(/agree_with_github_message/);
  });
});
