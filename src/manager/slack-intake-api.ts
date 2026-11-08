import type { SlackReadClient } from "../shared/integrations/slack/client.js";

export interface SlackIntakeChannel {
  id: string;
  name: string;
  isMember: boolean;
}

export interface SlackIntakeUser {
  id: string;
  name: string;
  teamId: string | null;
  isBot: boolean;
  deleted: boolean;
  guest: boolean;
}

export interface SlackIntakeMessage {
  ts: string;
  threadTs: string | null;
  user: string | null;
  botId?: string;
  subtype?: string;
  text: string;
  replyCount: number;
  fileCount: number;
}

interface RawMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  files?: unknown[];
}

/** Compares Slack `seconds.microseconds` timestamps numerically. */
export function compareSlackTs(a: string, b: string): number {
  const [aSeconds, aMicros = "0"] = a.split(".");
  const [bSeconds, bMicros = "0"] = b.split(".");
  return Number(aSeconds) - Number(bSeconds) || Number(aMicros.padEnd(6, "0")) - Number(bMicros.padEnd(6, "0"));
}

export class SlackIntakeApi {
  constructor(private readonly client: Pick<SlackReadClient, "call">) {}

  async getChannel(channelId: string): Promise<SlackIntakeChannel> {
    const response = await this.client.call("conversations.info", { channel: channelId }) as {
      ok?: boolean; error?: string; channel?: { id?: string; name?: string; is_member?: boolean };
    };
    if (!response.ok || response.channel?.id !== channelId || !response.channel.name) {
      throw new Error(`Slack conversations.info failed for ${channelId}: ${response.error ?? "missing channel name"}`);
    }
    return { id: channelId, name: response.channel.name, isMember: response.channel.is_member === true };
  }

  async getUser(userId: string): Promise<SlackIntakeUser> {
    const response = await this.client.call("users.info", { user: userId }) as {
      ok?: boolean; error?: string;
      user?: {
        id?: string; name?: string; real_name?: string; team_id?: string; is_bot?: boolean; deleted?: boolean;
        is_restricted?: boolean; is_ultra_restricted?: boolean; profile?: { real_name?: string; display_name?: string };
      };
    };
    const user = response.user;
    if (!response.ok || !user || user.id !== userId) throw new Error(`Slack users.info failed for ${userId}: ${response.error ?? "user mismatch"}`);
    const name = user.profile?.real_name || user.real_name || user.profile?.display_name || user.name;
    if (!name) throw new Error(`Slack user ${userId} has no name`);
    return {
      id: userId,
      name,
      teamId: user.team_id ?? null,
      isBot: user.is_bot === true,
      deleted: user.deleted === true,
      guest: user.is_restricted === true || user.is_ultra_restricted === true,
    };
  }

  async readThread(channelId: string, threadTs: string): Promise<SlackIntakeMessage[]> {
    const messages: SlackIntakeMessage[] = [];
    await this.paginate("conversations.replies", { channel: channelId, ts: threadTs, limit: 200 }, (response) => {
      messages.push(...this.messagesOf(response, "conversations.replies"));
    });
    return messages.sort((a, b) => compareSlackTs(a.ts, b.ts));
  }

  /** Reads the whole thread containing `messageTs`, whether it is a thread root, a reply, or a standalone message. */
  async readMessageThread(channelId: string, messageTs: string): Promise<{ threadTs: string; messages: SlackIntakeMessage[] }> {
    const first = await this.readThread(channelId, messageTs);
    const target = first.find((message) => message.ts === messageTs);
    if (!target) throw new Error(`Slack message ${channelId}/${messageTs} was not found`);
    const threadTs = target.threadTs ?? target.ts;
    if (threadTs === messageTs || first.some((message) => message.ts === threadTs)) return { threadTs, messages: first };
    return { threadTs, messages: await this.readThread(channelId, threadTs) };
  }

  async getPermalink(channelId: string, messageTs: string): Promise<string> {
    const response = await this.client.call("chat.getPermalink", { channel: channelId, message_ts: messageTs }) as {
      ok?: boolean; error?: string; permalink?: string;
    };
    if (!response.ok || !response.permalink) throw new Error(`Slack chat.getPermalink failed for ${channelId}/${messageTs}: ${response.error ?? "missing permalink"}`);
    return response.permalink;
  }

  private messagesOf(response: unknown, method: string): SlackIntakeMessage[] {
    const page = (response as { messages?: RawMessage[] }).messages;
    if (!Array.isArray(page)) throw new Error(`Slack ${method} omitted messages`);
    return page.map((message) => {
      if (!message.ts) throw new Error(`Slack ${method} returned a message without a timestamp`);
      return {
        ts: message.ts,
        threadTs: message.thread_ts ?? null,
        user: message.user ?? null,
        ...(message.bot_id ? { botId: message.bot_id } : {}),
        ...(message.subtype ? { subtype: message.subtype } : {}),
        text: message.text ?? "",
        replyCount: message.reply_count ?? 0,
        fileCount: message.files?.length ?? 0,
      };
    });
  }

  private async paginate(method: string, params: Record<string, string | number | boolean>, onPage: (response: unknown) => void): Promise<void> {
    for await (const response of this.pages(method, params)) onPage(response);
  }

  private async *pages(method: string, params: Record<string, string | number | boolean>): AsyncGenerator<unknown> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.client.call(method, { ...params, ...(cursor ? { cursor } : {}) }) as {
        ok?: boolean; error?: string; has_more?: boolean; response_metadata?: { next_cursor?: string };
      };
      if (!response.ok) throw new Error(`Slack ${method} failed: ${response.error ?? "unknown error"}`);
      yield response;
      cursor = response.response_metadata?.next_cursor || undefined;
      if (response.has_more && !cursor) throw new Error(`Slack ${method} has more results but no pagination cursor`);
      if (cursor && seen.has(cursor)) throw new Error(`Slack ${method} pagination repeated a cursor`);
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
}
