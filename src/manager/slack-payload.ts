import type { SlackTaskRecord, SlackThreadKey } from "../db/client.js";
import type { SlackThreadMessage } from "./slack-thread-api.js";

const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_MESSAGE_CHARS = 64_000;
const MAX_QUOTE_CHARS = 240;

export function buildCoordinatorPayload(key: SlackThreadKey, pendingTs: string[], thread: SlackThreadMessage[], tasks: SlackTaskRecord[]): string {
  const byTs = new Map(thread.map((message) => [message.ts, message]));
  let remaining = MAX_TOTAL_MESSAGE_CHARS;
  const messages = pendingTs.map((ts) => {
    const message = byTs.get(ts);
    if (!message) throw new Error(`Slack thread ${key.channelId}/${key.threadTs} omitted unprocessed message ${ts}`);
    const included = Math.min(message.text.length, MAX_MESSAGE_CHARS, remaining);
    remaining -= included;
    return {
      ts,
      user: message.user,
      text: message.text.slice(0, included),
      fileCount: message.fileCount ?? 0,
      blockCount: message.blockCount ?? 0,
      textLength: message.text.length,
      truncated: included < message.text.length,
      omittedCharacters: message.text.length - included,
      readReference: { channel: key.channelId, threadTs: key.threadTs, messageTs: ts },
    };
  });
  return JSON.stringify({
    thread: key,
    messages,
    truncation: {
      perMessageCharacterLimit: MAX_MESSAGE_CHARS,
      aggregateCharacterLimit: MAX_TOTAL_MESSAGE_CHARS,
      any: messages.some((message) => message.truncated),
      totalCharacters: messages.reduce((sum, message) => sum + message.textLength, 0),
      includedCharacters: messages.reduce((sum, message) => sum + message.text.length, 0),
      omittedCharacters: messages.reduce((sum, message) => sum + message.omittedCharacters, 0),
    },
    tasks: tasks.map((task) => ({
      id: task.id,
      type: task.type,
      state: task.state,
      sourceTs: task.sourceTs,
      quote: task.quote?.slice(0, MAX_QUOTE_CHARS) ?? null,
      quoteTruncated: (task.quote?.length ?? 0) > MAX_QUOTE_CHARS,
      ticketUrl: task.ticketUrl,
      hasResult: task.result !== null,
    })),
  });
}
