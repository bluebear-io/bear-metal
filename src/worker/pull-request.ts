import { writeFile } from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { commitAll, createLogger, getCurrentBranch, getRemoteRef, push } from "../shared/index.js";
import type { BotIdentity, PullRequestRef } from "../shared/index.js";
import type { WorkerGitHub } from "./types.js";
import { assertRepoRootInWorkspace } from "./workspace-guard.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:pull-request",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

/** Git environment for a workspace built by `runWorkspaceBuilder`: pushes authenticate through its askpass, commits as the bot. */
export function workspaceGitEnv(netrcDir: string, bot: BotIdentity): NodeJS.ProcessEnv {
  const botEmail = `${bot.userNumericId}+${bot.login}@users.noreply.github.com`;
  return {
    GIT_ASKPASS: resolve(netrcDir, "askpass.sh"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "git@github.com:",
    GIT_AUTHOR_NAME: bot.login,
    GIT_AUTHOR_EMAIL: botEmail,
    GIT_COMMITTER_NAME: bot.login,
    GIT_COMMITTER_EMAIL: botEmail,
  };
}

/**
 * The `commit_changes` and `push_for_review` tools, shared by every task that opens pull requests.
 * `existing` lists PRs a push should update instead of opening a new one; `onPullRequest` runs after each push.
 */
export function createCommitAndPushTools(input: {
  workspaceRoot: string;
  github: WorkerGitHub;
  netrcDir: string;
  gitEnv: NodeJS.ProcessEnv;
  labels?: readonly string[];
  signal?: AbortSignal;
  existing: () => readonly PullRequestRef[];
  onPullRequest: (pr: PullRequestRef) => Promise<void> | void;
}) {
  const commitChanges = defineTool({
    name: "commit_changes",
    label: "Commit changes",
    description: "Switch to the task branch (creating it when missing), stage every change in the repository, and commit it.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Absolute path to the git repository root containing the changes." }),
      branch: Type.String({ description: "Task branch to commit on, following the repository's branching strategy. Never main or master." }),
      message: Type.String({ description: "Commit message following the repository's commit convention." }),
    }),
    execute: async (_toolCallId, params) => {
      input.signal?.throwIfAborted();
      const repoRoot = assertRepoRootInWorkspace(input.workspaceRoot, params.repoRoot);
      const sha = await commitAll(repoRoot, params.branch, params.message, input.gitEnv);
      return { content: [{ type: "text" as const, text: `Committed ${sha} on ${params.branch}.` }], details: { sha } };
    },
  });

  const pushForReview = defineTool({
    name: "push_for_review",
    label: "Push for review",
    description: "Push and create or update the pull request for a repository with completed code changes.",
    parameters: Type.Object({
      repoRoot: Type.String({ description: "Absolute path to the git repository root containing the changes." }),
      prTitle: Type.String({ description: "Pull request title to use when creating a new PR." }),
      prBody: Type.String({ description: "Pull request body to use when creating a new PR." }),
      baseBranch: Type.Optional(Type.String({ description: "Base branch for a new PR. Defaults to repository default branch." })),
    }),
    execute: async (_toolCallId, params) => {
      input.signal?.throwIfAborted();
      logger.debug({ repoRoot: params.repoRoot }, "pi tool: push_for_review");
      const repoRoot = assertRepoRootInWorkspace(input.workspaceRoot, params.repoRoot);
      // Installation tokens expire after 1 hour; refresh before pushing.
      const freshToken = await input.github.getInstallationToken();
      input.signal?.throwIfAborted();
      await writeFile(resolve(input.netrcDir, ".netrc"), `machine github.com login x-access-token password ${freshToken}\n`, { mode: 0o600 });
      input.signal?.throwIfAborted();
      await push(repoRoot, input.gitEnv);
      const remote = await getRemoteRef(repoRoot);
      input.signal?.throwIfAborted();
      // A task opens at most one PR per repository; a later push updates it.
      const pr = input.existing().find((p) => p.owner === remote.owner && p.repo === remote.repo)
        ?? await input.github.createPullRequest({
          owner: remote.owner,
          repo: remote.repo,
          title: params.prTitle,
          head: await getCurrentBranch(repoRoot),
          base: params.baseBranch ?? await input.github.getDefaultBranch(remote.owner, remote.repo),
          body: params.prBody,
        });
      input.signal?.throwIfAborted();
      if (input.labels?.length && input.github.addLabels) {
        try {
          await input.github.addLabels(pr, input.labels);
        } catch (err) {
          logger.warn({ err, pr }, "failed to apply pull request labels");
        }
      }
      await input.onPullRequest(pr);
      return {
        content: [{ type: "text" as const, text: `Pushed code for PR ${pr.owner}/${pr.repo}#${pr.number}.` }],
        details: { pr },
      };
    },
  });

  return { commitChanges, pushForReview };
}
