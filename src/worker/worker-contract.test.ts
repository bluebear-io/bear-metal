import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../shared/index.js";
import { buildWorkerPrompt } from "./prompts.js";
import { validateDispatchInputs } from "./dispatch.js";
import type { WorkerInputContext } from "./types.js";

describe("worker contract", () => {
  it("rejects iteration without PR", () => {
    expect(() => validateDispatchInputs("iteration", "ABC-1", [])).toThrow(/requires at least one pull request/);
  });

  it("rejects new state with PR", () => {
    expect(() =>
      validateDispatchInputs("new", "ABC-1", [{ owner: "your-org", repo: "bear-metal", number: 1 }]),
    ).toThrow(/must not include any pull requests/);
  });

  it("accepts ssh and https remotes", () => {
    expect(parseGitHubRemote("git@github.com:your-org/bear-metal.git")).toEqual({
      owner: "your-org",
      repo: "bear-metal",
    });
    expect(parseGitHubRemote("https://github.com/your-org/handler.git")).toEqual({
      owner: "your-org",
      repo: "handler",
    });
  });

  it("builds state-specific iteration instructions and excludes respond_to_ticket_reporter", () => {
    const context: WorkerInputContext = {
      state: "iteration",
      ticketId: "ABC-1",
      prs: [{ owner: "your-org", repo: "bear-metal", number: 7 }],
      ticket: {
        issue: {
          id: "issue-id",
          identifier: "ABC-1",
          title: "Fix thing",
          description: null,
          url: "https://linear.app/your-workspace/issue/ABC-1/fix-thing",
          branchName: "feature/abc-1-fix-thing",
          status: { name: "Todo", type: "unstarted" },
          labels: ["bear-metal"],
          teamKey: "ABC",
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
          completedIssueComments: [],
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
    expect(prompt).toMatch(/ABC-1/);
    expect(prompt).not.toMatch(/respond_to_ticket_reporter/);
  });

  it("builds state-specific new task instructions with respond_to_ticket_reporter", () => {
    const context: WorkerInputContext = {
      state: "new",
      ticketId: "ABC-2",
      prs: [],
      ticket: {
        issue: {
          id: "issue-id",
          identifier: "ABC-2",
          title: "New thing",
          description: null,
          url: "https://linear.app/your-workspace/issue/ABC-2/new-thing",
          branchName: "feature/abc-2-new-thing",
          status: { name: "Todo", type: "unstarted" },
          labels: ["bear-metal"],
          teamKey: "ABC",
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

  it("allows customer-data work for a Research ticket on the Bear Metal Bedrock provider", () => {
    const context = makeContext("new", "ABC-RESEARCH");
    context.ticket.issue.labels = ["bear-metal", "Research"];

    const prompt = buildWorkerPrompt(context, { llmProvider: "amazon-bedrock" });

    expect(prompt).toContain("Bear Metal provider for this run: `amazon-bedrock`");
    expect(prompt).toContain("This ticket has the `Research` label");
    expect(prompt).toContain("This worker already runs on Bedrock");
    expect(prompt).toContain("do not wait for a human or ask to rerun under `claude-research`");
  });

  it("keeps the CLAUDE_CODE_USE_BEDROCK gate authoritative outside Bear Metal workers", () => {
    const context = makeContext("new", "ABC-RESEARCH");
    context.ticket.issue.labels = ["bear-metal", "Research"];

    const prompt = buildWorkerPrompt(context, { llmProvider: "amazon-bedrock" });

    expect(prompt).toContain("Customer-data LLM policy (Bear Metal worker session)");
    expect(prompt).toContain("This policy governs only this Bear Metal worker session");
    expect(prompt).toContain(
      "keep the `CLAUDE_CODE_USE_BEDROCK` / `claude-research` requirement",
    );
    expect(prompt).toContain(
      "For this Bear Metal Research worker only, `CLAUDE_CODE_USE_BEDROCK` is not the authoritative signal",
    );
    expect(prompt).toContain("do not edit repository guidance to weaken the gate for other users");
  });

  it("refuses customer-data work on the Anthropic path even with a Research label", () => {
    const context = makeContext("new", "ABC-ANTHROPIC");
    context.ticket.issue.labels = ["Research"];

    const prompt = buildWorkerPrompt(context, { llmProvider: "anthropic" });

    expect(prompt).toContain("Bear Metal provider for this run: `anthropic`");
    expect(prompt).toContain("If either condition is false, refuse to access customer data");
  });

  it("refuses customer-data work for an unlabeled Bedrock ticket", () => {
    const context = makeContext("new", "ABC-UNLABELED");
    context.ticket.issue.labels = ["bear-metal"];

    const prompt = buildWorkerPrompt(context, { llmProvider: "amazon-bedrock" });

    expect(prompt).toContain("This ticket does not have the `Research` label");
    expect(prompt).toContain("If either condition is false, refuse to access customer data");
  });

  it("includes attachment paths without embedding attachment contents", () => {
    const context = makeContext("new", "ABC-3");
    context.evidenceAttachments = [
      { title: "failure.log", path: "/workspace/.linear-artifacts/001-failure.log", size: 2_000_000 },
    ];

    const prompt = buildWorkerPrompt(context);

    expect(prompt).toContain("/workspace/.linear-artifacts/001-failure.log");
    expect(prompt).toContain('"size": 2000000');
    expect(prompt).not.toContain("a".repeat(1_000));
  });
});

function makeContext(state: "new", ticketId: string): WorkerInputContext {
  return {
    state,
    ticketId,
    prs: [],
    ticket: {
      issue: {
        id: "issue-id",
        identifier: ticketId,
        title: "Large evidence task",
        description: "Inspect the attached evidence.",
        url: `https://linear.app/workspace/issue/${ticketId}`,
        branchName: `fix/${ticketId}/evidence`,
        status: { name: "Todo", type: "unstarted" },
        priority: 2,
        labels: [],
        teamKey: "ABC",
        assignee: null,
        delegate: { id: "agent" },
      },
      comments: [],
    },
    pullRequests: [],
    cloneScript: {
      agentWorkdir: "/workspace",
      workspaceDir: "/workspace",
      stdout: "",
      stderr: "",
      netrcDir: "/tmp/netrc",
    },
  };
}
