import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "./git.js";
import { buildWorkerPrompt } from "./prompts.js";
import { validateDispatchInputs } from "./dispatch.js";
import type { WorkerInputContext } from "./types.js";

describe("worker contract", () => {
  it("rejects iteration without PR", () => {
    expect(() => validateDispatchInputs("iteration", "DEN-1", null)).toThrow(/requires a pull request/);
  });

  it("rejects new state with PR", () => {
    expect(() =>
      validateDispatchInputs("new", "DEN-1", { org: "bluebear-io", repo: "bear-metal", number: "1" }),
    ).toThrow(/must not include a pull request/);
  });

  it("accepts ssh and https remotes", () => {
    expect(parseGitHubRemote("git@github.com:bluebear-io/bear-metal.git")).toEqual({
      org: "bluebear-io",
      repo: "bear-metal",
    });
    expect(parseGitHubRemote("https://github.com/Blue-Bear-Security/handler.git")).toEqual({
      org: "Blue-Bear-Security",
      repo: "handler",
    });
  });

  it("builds state-specific iteration instructions", () => {
    const context: WorkerInputContext = {
      state: "iteration",
      ticketId: "DEN-1",
      pr: { org: "bluebear-io", repo: "bear-metal", number: "7" },
      ticket: { issue: { title: "Fix thing" }, comments: [] },
      pullRequest: {
        pullRequest: { number: 7 },
        failedCheckRuns: [],
        failedStatuses: [],
        unresolvedReviewThreads: [],
      },
      cloneScript: {
        scriptPath: "/tmp/script.sh",
        workspaceDir: "/tmp/workspace",
        stdout: "",
        stderr: "",
      },
    };

    const prompt = buildWorkerPrompt(context);
    expect(prompt).toMatch(/This is an iteration on an existing pull request/);
    expect(prompt).toMatch(/agree_with_github_message/);
    expect(prompt).toMatch(/DEN-1/);
  });
});
