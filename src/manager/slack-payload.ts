import type { SlackMessageEdit, SlackTaskRecord, SlackThreadKey } from "../db/client.js";
import type { SlackThreadMessage } from "./slack-thread-api.js";

const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_MESSAGE_CHARS = 64_000;
const MAX_QUOTE_CHARS = 240;

export function buildCoordinatorPayload(key: SlackThreadKey, pendingTs: string[], thread: SlackThreadMessage[], tasks: SlackTaskRecord[], edits: SlackMessageEdit[] = []): string {
  const byTs = new Map(thread.map((message) => [message.ts, message]));
  const editByTs = new Map(edits.map((edit) => [edit.ts, edit]));
  let remaining = MAX_TOTAL_MESSAGE_CHARS;
  const messages = pendingTs.map((ts) => {
    const edit = editByTs.get(ts);
    const message = byTs.get(edit?.originalTs ?? ts);
    if (!message) throw new Error(`Slack thread ${key.channelId}/${key.threadTs} omitted unprocessed message ${ts}`);
    const fullText = edit?.text ?? message.text;
    const included = Math.min(fullText.length, MAX_MESSAGE_CHARS, remaining);
    remaining -= included;
    return {
      ts,
      kind: edit ? "edit" : "message",
      originalMessageTs: edit?.originalTs ?? ts,
      user: edit?.user ?? message.user,
      text: fullText.slice(0, included),
      fileCount: message.fileCount ?? 0,
      blockCount: message.blockCount ?? 0,
      textLength: fullText.length,
      truncated: included < fullText.length,
      omittedCharacters: fullText.length - included,
      readReference: { channel: key.channelId, threadTs: key.threadTs, messageTs: edit?.originalTs ?? ts, ...(edit ? { revisionTs: ts } : {}) },
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
      supersededBy: task.supersededBy,
      quote: task.quote?.slice(0, MAX_QUOTE_CHARS) ?? null,
      quoteTruncated: (task.quote?.length ?? 0) > MAX_QUOTE_CHARS,
      ticketUrl: task.ticketUrl,
      hasResult: task.result !== null,
    })),
  });
}
