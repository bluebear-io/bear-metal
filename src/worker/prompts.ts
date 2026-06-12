import type { WorkerInputContext } from "./types.js";

export function buildWorkerPrompt(context: WorkerInputContext): string {
  const isNew = context.state === "new";

  const finishToolsSection = isNew
    ? [
        "IMPORTANT: You must complete this task by calling EITHER:",
        "- `wrote_code` — after you implement and commit the changes.",
        "- `respond_to_ticket_reporter` — if you cannot proceed and need human input.",
        "",
        "Do NOT call both. Do NOT output a text response to signal completion.",
        "Calling one of those two tools is the only valid way to finish.",
      ]
    : [
        "For every review thread, you MUST choose exactly one action:",
        "- `agree_with_github_message` — if you agree and have fixed the code.",
        "- `disagree_with_github_message` — if you disagree, reply with a concrete explanation backed by clear code-based evidence.",
        "- `respond_to_comment_writer` — if you are blocked on this thread and need human input.",
        "",
        "If you made ANY code changes, you must call `wrote_code` before exiting.",
        "Do NOT output a text response to signal completion. The only valid way to finish is calling the above tools for each thread, plus `wrote_code` if you wrote code.",
      ];

  const planFilePath = `docs/plans/${context.ticketId}.md`;

  const taskInstructions = isNew
    ? [
        "1. Read the codebase to understand context.",
        "2. Create a branch named after the ticket (e.g. feature/den-XXXX-short-description).",
        `3. Write a task plan to \`${planFilePath}\` describing the intended changes, the files you expect to touch, and the verification strategy. Commit it together with the code so it ships as part of the PR.`,
        "4. Implement the changes.",
        "5. Call `wrote_code` to commit, push, and open the PR.",
        "   OR call `respond_to_ticket_reporter` if you are blocked.",
      ]
    : [
        "1. Check out the existing PR branch.",
        "2. If any PR context has `mergeable: false`, the head branch conflicts with its base. Rebase / merge the base branch into the PR head, resolve the conflicts, and push.",
        "3. For each failed check: read the code and logs, find the root cause, fix it.",
        "4. For each unresolved review thread: read the code and respond using the tools above.",
        `5. If baloo posted a fidelity report comparing the PR against the plan in \`${planFilePath}\`, read every gap it lists. For each gap, decide whether it is meaningful (real divergence from the ticket spec or the committed plan) or noise. Address meaningful gaps with code changes; for noise, reply on the thread explaining why the gap is not actionable.`,
        "6. Call `wrote_code` once all code changes are done.",
      ];

  const blockerNote = isNew
    ? [
        "If at any step you are blocked or the ticket is missing critical information,",
        "call `respond_to_ticket_reporter` with the exact question or blocker instead.",
      ]
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
    `- Repository root: ${context.cloneScript.workspaceDir}/blueden`,
    "- Never read, write, search, or cd outside the repository root.",
    "- Sub-repositories (handler, bear-metal, etc.) are subdirectories of that path.",
    "",
    `Steps for this ${isNew ? "new task" : "PR iteration"}:`,
    ...taskInstructions,
    "",
    ...blockerNote,
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}
