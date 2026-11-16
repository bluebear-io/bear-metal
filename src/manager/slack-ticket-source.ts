export interface SlackTicketSource {
  channelId: string;
  threadTs: string;
  permalink: string;
}

export function slackSourceSection(source: SlackTicketSource): string {
  return [
    "## Source Slack thread",
    `This ticket was created from a Slack thread: ${source.permalink}`,
    `Before asking any question, read the whole thread with \`slack_read\` (operation \`thread_replies\`, channel \`${source.channelId}\`, ts \`${source.threadTs}\`), including its files and any research results posted there.`,
    "Take the context, decisions and answers from the thread. Ask only questions the thread does not answer.",
  ].join("\n");
}

export function withSlackSource(description: string, source: SlackTicketSource): string {
  return `${description.trimEnd()}\n\n${slackSourceSection(source)}`;
}
