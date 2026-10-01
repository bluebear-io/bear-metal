import type { SlackReadClient, SlackIntegration } from "../shared/integrations/slack/client.js";
import type { SlackThreadKey } from "../db/client.js";

export interface SlackThreadMessage {
  ts: string;
  user: string | null;
  botId?: string;
  subtype?: string;
  text: string;
  fileCount?: number;
  blockCount?: number;
}

export class SlackThreadApi {
  constructor(private readonly readClient: SlackReadClient, private readonly writer: SlackIntegration) {}

  async readThread(key: SlackThreadKey, oldest: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = await this.readClient.call("conversations.replies", {
        channel: key.channelId,
        ts: key.threadTs,
        oldest,
        inclusive: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ ts?: string; user?: string; bot_id?: string; subtype?: string; text?: string; files?: unknown[]; blocks?: unknown[] }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      if (!response.ok || !Array.isArray(response.messages)) {
        throw new Error(`Slack conversations.replies failed: ${response.error ?? "missing messages"}`);
      }
      for (const message of response.messages) {
        if (!message.ts) throw new Error("Slack thread reply omitted timestamp");
        messages.push({
          ts: message.ts, user: message.user ?? null, botId: message.bot_id, subtype: message.subtype, text: message.text ?? "",
          fileCount: message.files?.length ?? 0, blockCount: message.blocks?.length ?? 0,
        });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (response.has_more && !cursor) throw new Error("Slack thread has more replies but no pagination cursor");
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack thread pagination repeated a cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return messages;
  }

  async reply(key: SlackThreadKey, text: string): Promise<string> {
    return this.writer.postThreadMessage(key.channelId, key.threadTs, text);
  }
}
