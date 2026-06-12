import type { PullRequestContext, ReviewThread } from "../shared/index.js";
import type { IssueComment } from "../shared/integrations/github/types.js";
import type { WorkerInputContext } from "./types.js";

export function buildWorkerPrompt(
  context: WorkerInputContext,
  opts?: { repoRoot?: string; agentsMd?: string },
): string {
  const isNew = context.state === "new";
  const repoRoot = opts?.repoRoot ?? context.cloneScript.workspaceDir;
  const planFallback = `docs/plans/${context.ticketId}.md`;

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
        `3. Write a plan file describing the intended changes, the files you expect to touch, and the verification strategy, all according to the repository standards. If no plan path is specified in the repository standards, create it at \`${planFallback}\`. Commit it together with the code so it ships as part of the PR.`,
        "4. Implement the changes.",
        "5. Commit your changes via git, then call `push_for_review` to push and open the PR.",
        "   OR call `respond_to_ticket_reporter` if you are blocked.",
      ]
    : [
        "1. Check out the existing PR branch.",
        "2. If any PR context has `mergeable: false`, the head branch conflicts with its base. Rebase / merge the base branch into the PR head, resolve the conflicts.",
        "3. For each failed check: read the code and logs, find the root cause, fix it.",
        "4. For each open comment: read the context and respond using the tools above.",
        "5. Call `push_for_review` once all code changes are done.",
      ];

  const blockerNote = isNew
    ? [
        "If at any step you are blocked or the ticket is missing critical information,",
        "call `respond_to_ticket_reporter` with the exact question or blocker instead.",
      ]
    : [];

  const agentsSection = opts?.agentsMd
    ? ["Repository guidelines:", opts.agentsMd, ""]
    : [];

  return [
    "You are bear-metal, an autonomous coding agent.",
    "",
    ...finishToolsSection,
    "",
    "Rules:",
    "- Use the Linear and GitHub context below as the sole source of truth.",
    "- Do not invent missing requirements.",
    "- Do not silently work around failures.",
    `- Repository root: ${repoRoot}`,
    "- Never read, write, search, or cd outside the repository root.",
    "",
    `Steps for this ${isNew ? "new task" : "PR iteration"}:`,
    ...taskInstructions,
    "",
    ...blockerNote,
    "",
    "Context JSON:",
    JSON.stringify(toPiContext(context), null, 2),
    "",
    ...agentsSection,
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
