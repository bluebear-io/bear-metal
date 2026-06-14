import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchResult, WorkerInputContext } from "./types.js";

const dispatchMock = vi.hoisted(() => ({
  calls: [] as string[],
  workspaceDir: "/tmp/dispatch-workspace",
}));

vi.mock("./clone.js", () => ({
  workspaceForTicket: () => dispatchMock.workspaceDir,
  runWorkspaceBuilder: async () => {
    dispatchMock.calls.push("clone");
    return {
      agentWorkdir: join(dispatchMock.workspaceDir, "agent"),
      workspaceDir: dispatchMock.workspaceDir,
      stdout: "",
      stderr: "",
      netrcDir: "/tmp/netrc",
    };
  },
}));

vi.mock("./pi.js", () => ({
  runPiWorker: async (_input: { context: WorkerInputContext }): Promise<DispatchResult> => {
    dispatchMock.calls.push("pi");
    return { status: "pending", prs: [] };
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
      integrations: {
        github: makeGithub(),
        linear: {
          getTicketContext: vi.fn(async () => makeTicketContext()),
          moveTicketToInProgress,
          moveTicketToInReview: vi.fn(),
          commentAndHandBack: vi.fn(),
          getUserEmail: vi.fn().mockResolvedValue(null),
        },
      },
    });

    expect(result).toEqual({ status: "pending", prs: [] });
    expect(moveTicketToInProgress).toHaveBeenCalledWith("DEN-1");
    expect(dispatchMock.calls.indexOf("in-progress")).toBeLessThan(dispatchMock.calls.indexOf("pi"));
  });

  describe("cleanup", () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), "dispatch-cleanup-"));
      dispatchMock.workspaceDir = tempRoot;
      // Simulate a checked-out tree from a previous workspace builder run.
      await mkdir(join(tempRoot, "agent", "src"), { recursive: true });
      await writeFile(join(tempRoot, "agent", "marker.txt"), "present", "utf8");
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      dispatchMock.workspaceDir = "/tmp/dispatch-workspace";
    });

    it("removes the agent workdir after Pi finishes", async () => {
      const { dispatch } = await import("./dispatch.js");
      dispatchMock.calls.length = 0;

      await dispatch({
        state: "new",
        ticketId: "DEN-1",
        integrations: makeIntegrations(),
      });

      await expect(stat(join(tempRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("removes the agent workdir even when Pi throws", async () => {
      const pi = await import("./pi.js");
      const spy = vi.spyOn(pi, "runPiWorker").mockRejectedValueOnce(new Error("boom"));
      const { dispatch } = await import("./dispatch.js");
      dispatchMock.calls.length = 0;

      await expect(
        dispatch({
          state: "new",
          ticketId: "DEN-1",
          integrations: makeIntegrations(),
        }),
      ).rejects.toThrow("boom");

      await expect(stat(join(tempRoot, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
      spy.mockRestore();
    });
  });
});

function makeTicketContext() {
  return {
    issue: {
      id: "issue-id",
      identifier: "DEN-1",
      title: "Build thing",
      description: null,
      url: "https://linear.app/bluebear/issue/DEN-1/build-thing",
      branchName: "feature/den-1-build-thing",
      status: { name: "Todo", type: "unstarted" },
      labels: ["bear-metal"],
      teamKey: "DEN",
      assignee: { id: "creator" },
      delegate: { id: "agent" },
      priority: 0,
    },
    comments: [],
  };
}

function makeIntegrations() {
  return {
    github: makeGithub(),
    linear: {
      getTicketContext: vi.fn(async () => makeTicketContext()),
      moveTicketToInProgress: vi.fn(async () => {}),
      moveTicketToInReview: vi.fn(),
      commentAndHandBack: vi.fn(),
      getUserEmail: vi.fn().mockResolvedValue(null),
    },
  };
}

function makeGithub() {
  return {
    getInstallationToken: vi.fn().mockResolvedValue("test-token"),
    getBotIdentity: vi.fn().mockResolvedValue({ login: "bear-metal-app[bot]", id: "bot-id", numericId: 12345 }),
    getPullRequestContext: vi.fn(),
    resolveReviewThread: vi.fn(),
    replyToReviewThread: vi.fn(),
    leaveComment: vi.fn().mockResolvedValue(undefined),
    getDefaultBranch: vi.fn(),
    createPullRequest: vi.fn(),
  };
}
