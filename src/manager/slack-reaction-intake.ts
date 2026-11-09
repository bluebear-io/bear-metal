import { createHash } from "node:crypto";
import { validateTaskCustomization } from "../customization/load.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import type { Logger } from "../shared/logger.js";
import type { SlackThreadApi, SlackThreadMessage } from "./slack-thread-api.js";

export interface SlackReaction {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  userId: string;
}

type ReactionTrigger = NonNullable<NonNullable<BearMetalConfig["slack"]>["reactionTrigger"]>;
type Linear = Pick<LinearIntegration, "findIssue" | "createSlackCodingTicket" | "findUserIdByEmail" | "addLabelsByName" | "delegateSlackCodingTicket">;
type Thread = Pick<SlackThreadApi, "readMessageThread" | "getUserEmail">;

const MAX_TITLE_CHARS = 80;
const MAX_THREAD_CHARS = 40_000;

// One Linear issue ID per Slack message: repeated reactions, concurrent reactions and retries all land on the
// same ticket, and Linear rejects a second create with that ID. Linear requires the UUID v4 layout.
export function reactionIssueId(reaction: Pick<SlackReaction, "workspaceId" | "channelId" | "messageTs">): string {
  const hex = createHash("sha256").update(`slack-reaction:${reaction.workspaceId}/${reaction.channelId}/${reaction.messageTs}`).digest("hex");
  const variant = (8 | (parseInt(hex[16]!, 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function ticketTitle(text: string): string {
  const line = text.split("\n").map((part) => part.replace(/<[^>|]*\|([^>]*)>/g, "$1").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim()).find(Boolean) ?? "";
  const title = line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
  return title ? `[Slack] ${title}` : "[Slack] Flagged request";
}

function ticketDescription(messages: readonly SlackThreadMessage[], flaggedTs: string, permalink: string, channelId: string, threadTs: string): string {
  const lines = messages.map((message) => {
    const author = message.user ? `<@${message.user}>` : message.botId ? `bot ${message.botId}` : "unknown";
    const marker = message.ts === flaggedTs ? " **(flagged)**" : "";
    const extras = (message.fileCount ?? 0) > 0 ? ` [${message.fileCount} file(s)]` : "";
    return `- ${author} at ${message.ts}${marker}${extras}:\n${message.text.split("\n").map((line) => `  > ${line}`).join("\n")}`;
  });
  let thread = lines.join("\n");
  if (thread.length > MAX_THREAD_CHARS) thread = `${thread.slice(0, MAX_THREAD_CHARS)}\n\n_Thread truncated._`;
  return [
    "A teammate flagged this Slack message for Bear Metal. Work out the request from the flagged message and its thread, then implement it.",
    "Do not post to Slack about this ticket.",
    "",
    `Source: ${permalink}`,
    `Read the full thread, files and user names with slack_read (channel \`${channelId}\`, thread \`${threadTs}\`).`,
    "",
    "## Thread",
    thread,
  ].join("\n");
}

export function createReactionIntake(input: {
  trigger: ReactionTrigger;
  api: Thread;
  linear: Linear;
  config: Pick<BearMetalConfig, "customizeTask">;
  logger: Logger;
}): (reaction: SlackReaction) => Promise<void> {
  return async (reaction) => {
    const id = reactionIssueId(reaction);
    let issue = await input.linear.findIssue(id);
    if (!issue) {
      const { threadTs, messages, permalink } = await input.api.readMessageThread(reaction.workspaceId, reaction.channelId, reaction.messageTs);
      const flagged = messages.find((message) => message.ts === reaction.messageTs)!;
      const assigneeId = await input.linear.findUserIdByEmail(await input.api.getUserEmail(reaction.userId));
      const description = ticketDescription(messages, reaction.messageTs, permalink, reaction.channelId, threadTs);
      issue = await input.linear.createSlackCodingTicket({
        id, teamId: input.trigger.linearTeamId, projectId: input.trigger.linearProjectId, title: ticketTitle(flagged.text), description, assigneeId,
      });
      await applyTicketLabels(input, id, issue.id, description);
    }
    // Re-delegating is harmless: finished tickets are never scheduled, and this recovers a failed earlier delegation.
    await input.linear.delegateSlackCodingTicket(issue.id);
    input.logger.info({ ...reaction, ticketId: issue.id, ticketUrl: issue.url }, "Slack reaction delegated a ticket to Bear Metal");
  };
}

async function applyTicketLabels(
  input: { linear: Linear; config: Pick<BearMetalConfig, "customizeTask">; logger: Logger },
  taskId: string,
  issueId: string,
  request: string,
): Promise<void> {
  try {
    const customization = validateTaskCustomization(await input.config.customizeTask({ type: "coding", id: taskId, trigger: "slack", request }));
    if (!customization.ticketLabels?.length) return;
    const missing = await input.linear.addLabelsByName(issueId, customization.ticketLabels);
    if (missing.length) input.logger.warn({ missing, issueId }, "ticket labels not found in Linear");
  } catch (err) {
    input.logger.warn({ err, issueId }, "failed to apply ticket labels");
  }
}
