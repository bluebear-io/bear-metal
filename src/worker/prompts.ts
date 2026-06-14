import type { PullRequestContext, ReviewThread } from "../shared/index.js";
import type { IssueComment } from "../shared/integrations/github/types.js";
import type { WorkerInputContext } from "./types.js";

export function buildWorkerPrompt(
  context: WorkerInputContext,
  opts?: { repoRoot?: string; agentsMd?: string; customSystemPrompt?: string },
): string {
  const isNew = context.state === "new";
  const repoRoot = opts?.repoRoot ?? context.cloneScript.workspaceDir;

  const finishToolsSection = isNew
    ? [
        "IMPORTANT: You must complete this task by calling EITHER:",
        "- `push_for_review` — after you implement and commit the changes.",
        "- `respond_to_ticket_reporter` — if you cannot proceed and need human input.",
        "",
        "Do NOT call both. Do NOT output a text response to signal completion.",
        "Calling one of those two tools is the only valid way to finish.",
      ]
    : [
        "For every open comment in `openComments`, you MUST choose exactly one action:",
        "- `agree_with_github_message` — if you agree and have fixed the code.",
        "- `disagree_with_github_message` — if you disagree, reply with a concrete explanation backed by clear code-based evidence.",
        "- `respond_to_comment_writer` — if you are blocked and need human input.",
        "- `mark_github_message_completed` — if the comment needs no action (informational, FYI, already handled).",
        "",
        "Every entry in `openComments` must be handled — leaving one unhandled causes a re-dispatch loop.",
        "If you made ANY code changes, you must call `push_for_review` before exiting.",
        "Do NOT output a text response to signal completion. The only valid way to finish is calling the above tools for each open comment, plus `push_for_review` if you wrote code.",
      ];

  const taskInstructions = isNew
    ? [
        "1. Read the codebase to understand context.",
        "2. Create a branch following the repository's branching strategy.",
        "3. Implement the changes following the repository standards.",
        "4. Commit your changes via git, then call `push_for_review` to push and open the PR.",
        "   OR call `respond_to_ticket_reporter` if you are blocked.",
      ]
    : [
        "1. Check out the existing PR branch.",
        "2. If any PR context has `mergeable: false`, the head branch conflicts with its base. Rebase / merge the base branch into the PR head, resolve the conflicts.",
        "3. For each failed check: read the code and logs, find the root cause, fix it.",
        "4. For each open comment: read the context and respond using the tools above.",
        "5. Call `push_for_review` once all code changes are done.",
      ];

  const customSystemPromptSection = opts?.customSystemPrompt
    ? [opts.customSystemPrompt, ""]
    : [];

  const agentsSection = opts?.agentsMd
    ? ["## Repository Guidelines", opts.agentsMd, ""]
    : [];

  return [
    "You are bear-metal, an autonomous coding agent.",
    "",
    ...finishToolsSection,
    "",
    `## Steps for this ${isNew ? "new task" : "PR iteration"}`,
    ...taskInstructions,
    "",
    "## Rules",
    "- Use the Linear and GitHub context below as the sole source of truth.",
    "- Do not invent missing requirements.",
    "- Do not work around failures to operate. If you cannot perform the task, stop and give up instead of looping forever on failing bash calls.",
    "- Do not shell out to discover state (branch existence, PR status, ticket state). All of it is already in the context JSON below — read it there.",
    `- Repository root: ${repoRoot}`,
    "- Never read, write, search, or cd outside the repository root.",
    "",
    ...customSystemPromptSection,
    ...agentsSection,
    "## Task Context",
    JSON.stringify(toPiContext(context), null, 2),
  ].join("\n");
}

function toPiContext(context: WorkerInputContext) {
  return {
    ...context,
    pullRequests: context.pullRequests.map(toPiPullRequestContext),
  };
}

function toPiPullRequestContext(pr: PullRequestContext) {
  const { unresolvedReviewThreads, reviewThreads: _rt, issueComments, ...rest } = pr;
  return {
    ...rest,
    openComments: [
      ...unresolvedReviewThreads.map(threadToOpenComment),
      ...issueComments.map(issueCommentToOpenComment),
    ],
  };
}

function threadToOpenComment(t: ReviewThread) {
  return {
    id: t.id,
    path: t.path,
    line: t.line,
    comments: t.comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })),
  };
}

function issueCommentToOpenComment(c: IssueComment) {
  return {
    id: c.id,
    comments: [{ author: c.author, body: c.body, createdAt: c.createdAt }],
  };
}
