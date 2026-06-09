import { describe, expect, it, vi } from "vitest";
import type { DispatchResult, WorkerInputContext } from "./types.js";

const dispatchMock = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock("./clone.js", () => ({
  getPackageRoot: () => "/tmp/package-root",
  workspaceForTicket: () => "/tmp/dispatch-workspace",
  runCloneScript: async () => {
    dispatchMock.calls.push("clone");
    return {
      scriptPath: "/tmp/package-root/scripts/clone-target-repos.sh",
      workspaceDir: "/tmp/dispatch-workspace",
      stdout: "",
      stderr: "",
    };
  },
}));

vi.mock("./pi.js", () => ({
  runPiWorker: async (_input: { context: WorkerInputContext }): Promise<DispatchResult> => {
    dispatchMock.calls.push("pi");
    return { status: "pending", pr: null };
  },
}));

describe("dispatch", () => {
  it("moves the Linear ticket to In Progress before starting Pi", async () => {
    const { dispatch } = await import("./dispatch.js");
    dispatchMock.calls.length = 0;
    const moveTicketToInProgress = vi.fn(async () => {
      dispatchMock.calls.push("in-progress");
    });

    const result = await dispatch({
      state: "new",
      ticketId: "DEN-1",
      force: true,
      integrations: {
        github: makeGithub(),
        linear: {
          getTicketContext: vi.fn(async () => ({
            issue: {
              id: "issue-id",
              identifier: "DEN-1",
              title: "Build thing",
              description: null,
              url: "https://linear.app/bluebear/issue/DEN-1/build-thing",
              branchName: "feature/den-1-build-thing",
              status: { name: "Todo", type: "unstarted" },
              labels: ["bear-metal"],
            },
            comments: [],
          })),
          moveTicketToInProgress,
          commentAndAssignToCreator: vi.fn(),
        },
      },
    });

    expect(result).toEqual({ status: "pending", pr: null });
    expect(moveTicketToInProgress).toHaveBeenCalledWith("DEN-1");
    expect(dispatchMock.calls.indexOf("in-progress")).toBeLessThan(dispatchMock.calls.indexOf("pi"));
  });
});

function makeGithub() {
  return {
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    getDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
  };
}
