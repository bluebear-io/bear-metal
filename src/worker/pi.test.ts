import { describe, expect, it, vi } from "vitest";
import type { WorkerInputContext } from "./types.js";

const piMock = vi.hoisted(() => ({
  sessionDispose: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({
      setRuntimeApiKey: vi.fn(),
    }),
  },
  ModelRegistry: {
    create: () => ({}),
  },
  SessionManager: {
    inMemory: () => ({}),
  },
  defineTool: (definition: unknown) => definition,
  createAgentSession: async (input: { customTools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> }) => ({
    session: {
      prompt: async () => {
        const tool = input.customTools.find((candidate) => candidate.name === "respond_to_ticket_reporter");
        if (!tool) {
          throw new Error("respond_to_ticket_reporter tool was not registered");
        }
        await tool.execute("tool-call-id", { text: "Need a product decision." });
      },
      dispose: piMock.sessionDispose,
    },
  }),
}));

describe("runPiWorker", () => {
  it("comments and assigns the ticket to the creator when pending human response", async () => {
    const { runPiWorker } = await import("./pi.js");
    const commentAndAssignToCreator = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const context = makeContext();

    const result = await runPiWorker({
      context,
      github: makeGithub(),
      linear: {
        getTicketContext: vi.fn(),
        commentAndAssignToCreator,
      },
    });

    expect(commentAndAssignToCreator).toHaveBeenCalledWith("DEN-1", "Need a product decision.");
    expect(result).toEqual({ status: "pending", pr: null });
    expect(piMock.sessionDispose).toHaveBeenCalled();
  });
});

function makeContext(): WorkerInputContext {
  return {
    state: "new",
    ticketId: "DEN-1",
    pr: null,
    ticket: {
      issue: {
        id: "issue-id",
        identifier: "DEN-1",
        title: "Build thing",
        description: null,
        url: "https://linear.app/bluebear/issue/DEN-1/build-thing",
        branchName: "feature/den-1-build-thing",
        status: { name: "Todo", type: "unstarted" },
        labels: ["bear-metal"],
        assignee: { id: "user-1" },
      },
      comments: [],
    },
    pullRequest: null,
    cloneScript: {
      scriptPath: "/tmp/script.sh",
      workspaceDir: "/tmp/workspace",
      stdout: "",
      stderr: "",
    },
  };
}

function makeGithub() {
  return {
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    getDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
  };
}
