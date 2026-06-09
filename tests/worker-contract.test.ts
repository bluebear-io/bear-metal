import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubRemote } from "../worker/git.js";
import { buildWorkerPrompt } from "../worker/prompts.js";
import { validateDispatchInputs } from "../worker/index.js";
import type { WorkerInputContext } from "../worker/types.js";

test("validateDispatchInputs rejects iteration without PR", () => {
  assert.throws(() => validateDispatchInputs("iteration", "DEN-1", null), /requires a pull request/);
});

test("validateDispatchInputs rejects new state with PR", () => {
  assert.throws(
    () => validateDispatchInputs("new", "DEN-1", { org: "bluebear-io", repo: "bear-metal", number: "1" }),
    /must not include a pull request/,
  );
});

test("parseGitHubRemote accepts ssh and https remotes", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:bluebear-io/bear-metal.git"), {
    org: "bluebear-io",
    repo: "bear-metal",
  });
  assert.deepEqual(parseGitHubRemote("https://github.com/Blue-Bear-Security/handler.git"), {
    org: "Blue-Bear-Security",
    repo: "handler",
  });
});

test("buildWorkerPrompt uses state-specific iteration instructions", () => {
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
  assert.match(prompt, /This is an iteration on an existing pull request/);
  assert.match(prompt, /agree_with_github_message/);
  assert.match(prompt, /DEN-1/);
});
