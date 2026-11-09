import type { SlackReadClient, SlackIntegration } from "../shared/integrations/slack/client.js";
import type { SlackThreadKey } from "../db/client.js";

export interface SlackThreadMessage {
  ts: string;
  threadTs?: string;
  user: string | null;
  botId?: string;
  subtype?: string;
  text: string;
  fileCount?: number;
  blockCount?: number;
}

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

export class SlackThreadApi {
  constructor(private readonly readClient: Pick<SlackReadClient, "call">, private readonly writer: SlackIntegration) {}

  async getChannel(channelId: string): Promise<SlackIntakeChannel> {
    const response = await this.readClient.call("conversations.info", { channel: channelId }) as {
      ok?: boolean; error?: string; channel?: { id?: string; name?: string; is_member?: boolean };
    };
    if (!response.ok || response.channel?.id !== channelId || !response.channel.name) {
      throw new Error(`Slack conversations.info failed for ${channelId}: ${response.error ?? "missing channel name"}`);
    }
    return { id: channelId, name: response.channel.name, isMember: response.channel.is_member === true };
  }

  async getUser(userId: string): Promise<SlackIntakeUser> {
    const response = await this.readClient.call("users.info", { user: userId }) as {
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

  async getPermalink(channelId: string, messageTs: string): Promise<string> {
    const response = await this.readClient.call("chat.getPermalink", { channel: channelId, message_ts: messageTs }) as {
      ok?: boolean; error?: string; permalink?: string;
    };
    if (!response.ok || !response.permalink) throw new Error(`Slack chat.getPermalink failed for ${channelId}/${messageTs}: ${response.error ?? "missing permalink"}`);
    return response.permalink;
  }

  async readMessageThread(channelId: string, messageTs: string): Promise<{ threadTs: string; messages: SlackThreadMessage[] }> {
    const key = { channelId, threadTs: messageTs };
    const first = await this.readThread(key, "0");
    const target = first.find((message) => message.ts === messageTs);
    if (!target) throw new Error(`Slack message ${channelId}/${messageTs} was not found`);
    const threadTs = target.threadTs ?? target.ts;
    const messages = threadTs === messageTs || first.some((message) => message.ts === threadTs)
      ? first : await this.readThread({ ...key, threadTs }, "0");
    return { threadTs, messages };
  }

  async getUserEmail(userId: string): Promise<string> {
    const response = await this.readClient.call("users.info", { user: userId }) as {
      ok?: boolean; error?: string; user?: { id?: string; profile?: { email?: string } };
    };
    if (!response.ok || response.user?.id !== userId || !response.user.profile?.email) {
      throw new Error(`Cannot resolve Slack email for ${userId}: ${response.error ?? "missing user email"}`);
    }
    return response.user.profile.email;
  }

  async readThread(key: Omit<SlackThreadKey, "workspaceId"> & { workspaceId?: string }, oldest: string, latest?: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = await this.readClient.call("conversations.replies", {
        channel: key.channelId,
        ts: key.threadTs,
        oldest,
        ...(latest ? { latest } : {}),
        inclusive: true,
        limit: latest ? 1 : 200,
        ...(cursor ? { cursor } : {}),
      }) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ thread_ts?: string; ts?: string; user?: string; bot_id?: string; subtype?: string; text?: string; files?: unknown[]; blocks?: unknown[] }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      if (!response.ok || !Array.isArray(response.messages)) {
        throw new Error(`Slack conversations.replies failed: ${response.error ?? "missing messages"}`);
      }
      for (const message of response.messages) {
        if (!message.ts) throw new Error("Slack thread reply omitted timestamp");
        messages.push({
          ts: message.ts, ...(message.thread_ts ? { threadTs: message.thread_ts } : {}), user: message.user ?? null, botId: message.bot_id, subtype: message.subtype, text: message.text ?? "",
          fileCount: message.files?.length ?? 0, blockCount: message.blocks?.length ?? 0,
        });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
      if (latest && (response.has_more || cursor)) throw new Error("Slack bounded thread read unexpectedly paginated");
      if (response.has_more && !cursor) throw new Error("Slack thread has more replies but no pagination cursor");
      if (cursor && seenCursors.has(cursor)) throw new Error("Slack thread pagination repeated a cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return messages;
  }

  async react(key: SlackThreadKey, sourceTs: string, name: string): Promise<void> {
    await this.writer.addReaction(key.channelId, sourceTs, name);
  }

  async readThreadMessage(key: SlackThreadKey, ts: string): Promise<SlackThreadMessage | null> {
    const messages = await this.readThread(key, ts, ts);
    // conversations.replies returns the thread parent first even when oldest/latest exclude it.
    const candidates = ts === key.threadTs ? messages : messages.filter((message) => message.ts !== key.threadTs);
    if (candidates.length === 0) return null;
    if (candidates.length !== 1 || candidates[0]!.ts !== ts) {
      throw new Error(`Slack thread ${key.channelId}/${key.threadTs} returned unexpected messages for ${ts}: ${candidates.map((message) => message.ts).join(", ")}`);
    }
    return candidates[0]!;
  }

  async reply(key: SlackThreadKey, text: string): Promise<string> {
    return this.writer.postThreadMessage(key.channelId, key.threadTs, text);
  }

  async replyResearch(key: SlackThreadKey, userId: string, quote: string, answer: string, summary?: string): Promise<string | undefined> {
    const quoted = quote.replace(/\s+/g, " ").replace(/([\\*_`~])/g, "\\$1");
    const header = `Replying to <@${userId}>'s "${quoted}"`;
    if (summary !== undefined && Array.from(answer).length > 500) {
      if (!summary.trim() || summary.length > 600) throw new Error("Slack research summary must be 1–600 characters");
      await this.writer.postThreadMarkdownFile(key.channelId, key.threadTs, `${header}\n\n*TL;DR* - ${summary}`, answer);
      return;
    }
    if (answer.length + quote.length + 4 > 12_000) throw new Error("Slack research answer exceeds the Markdown block limit");
    return this.writer.postThreadMessage(
      key.channelId, key.threadTs, `${header}\n\n${answer}`,
      [
        { type: "section", text: { type: "mrkdwn", text: header } },
        { type: "markdown", text: answer },
      ],
    );
  }
}
