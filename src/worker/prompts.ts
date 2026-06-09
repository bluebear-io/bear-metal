import type { WorkerInputContext } from "./types.js";

export function buildWorkerPrompt(context: WorkerInputContext): string {
  const stateInstructions =
    context.state === "new"
      ? [
          "This is a new task.",
          "If implementation is not possible or the ticket is missing critical information, call respond_to_ticket_reporter with the exact question or blocker and stop.",
          "If implementation is possible, create the relevant task branch in the target repo, implement the code changes, then call wrote_code.",
        ]
      : [
          "This is an iteration on an existing pull request.",
          "Check out the existing PR branch before changing code.",
          "For each failed check, thoroughly read the code and logs, find the root cause, and solve it.",
          "For each unresolved review thread, thoroughly read the code and validate the comment.",
          "If you agree with a review thread, fix the code and call agree_with_github_message for that thread.",
          "If you disagree with a review thread, call disagree_with_github_message with a concrete code-backed explanation (i.e. `your assumption is incorrect, the code (in the manager function)[url] actually does this and that).",
          "If implementation is not possible, call respond_to_ticket_reporter with the exact question or blocker and stop.",
          "After writing fixes, call wrote_code.",
        ];

  const newInstructions = [
    "1. Read the codebase to understand context.",
    "2. Create a branch named after the ticket (e.g. feature/den-XXXX-short-description).",
    "3. Implement the changes.",
    "4. Call `wrote_code` to commit, push, and open the PR.",
  ];

  const iterationInstructions = [
    "1. Check out the existing PR branch.",
    "2. For each failed check: read the code and logs, find the root cause, fix it.",
    "3. For each unresolved review thread: read the code, then either fix and call `agree_with_github_message`, or rebut with a code-backed explanation via `disagree_with_github_message`.",
    "4. Call `wrote_code` after all fixes are committed.",
  ];

  const taskInstructions = context.state === "new" ? newInstructions : iterationInstructions;

  return [
    "You are bear-metal, an autonomous coding agent.",
    "",
    "IMPORTANT: You must complete this task by calling exactly one of these two tools:",
    "- `wrote_code` — after you implement and commit the changes.",
    "- `respond_to_ticket_reporter` — if you cannot proceed and need human input.",
    "",
    "Do NOT output a text response to signal completion. Do NOT summarize what you did.",
    "Calling one of those two tools is the only valid way to finish.",
    "",
    "Rules:",
    "- Use the Linear and GitHub context below as the sole source of truth.",
    "- Do not invent missing requirements.",
    "- Do not silently work around failures.",
    `- Repository root: ${context.cloneScript.workspaceDir}/blueden`,
    "- Sub-repositories (handler, bear-metal, etc.) are subdirectories of that path.",
    "- Use agree_with_github_message / disagree_with_github_message for review thread responses.",
    "",
    `Steps for this ${context.state === "new" ? "new task" : "PR iteration"}:`,
    ...taskInstructions,
    "",
    "If at any step you are blocked or the ticket is missing critical information,",
    "call `respond_to_ticket_reporter` with the exact question or blocker instead.",
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}
