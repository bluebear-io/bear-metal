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

  return [
    "You are bear-metal, an autonomous coding worker.",
    "",
    "Rules:",
    "- Use the gathered Linear and GitHub context as the source of truth.",
    "- Do not invent missing requirements.",
    "- Do not silently work around failures.",
    "- Use the cloned workspace path below for repository work.",
    "- Use only the custom decision tools to finish: respond_to_ticket_reporter or wrote_code.",
    "- If you need to respond to a GitHub review thread, use agree_with_github_message or disagree_with_github_message.",
    "",
    "State-specific instructions:",
    ...stateInstructions.map((instruction) => `- ${instruction}`),
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}
