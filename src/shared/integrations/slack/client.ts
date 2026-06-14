import type { Integration } from "../base.js";
import type { PullRequestRef } from "../github/types.js";
import type { Logger } from "../../logger.js";

export interface SlackIntegrationOptions {
  /** Slack bot user OAuth token (xoxb-...). */
  token: string;
  /** Target channel id or name. */
  channel: string;
  /** Optional override for the Slack Web API base URL (used in tests). */
  apiBaseUrl?: string;
  logger: Logger;
  /** Optional fetch implementation; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export type PullRequestNotificationKind = "opened" | "updated";

export interface PullRequestNotification {
  kind: PullRequestNotificationKind;
  pr: PullRequestRef;
  /** Linear ticket title. */
  title: string;
  /** PR HTML url. */
  url: string;
  /** Originating Linear ticket identifier (e.g. "DEN-2305"). */
  ticketId: string;
  ticketUrl: string;
  /** Assignee email for DM routing. When set, tries to DM the user first; falls back to channel on lookup failure. */
  recipientEmail?: string;
}

export interface NeedsInputNotification {
  /** Linear ticket identifier (e.g. "DEN-2305"). */
  ticketId: string;
  ticketUrl: string;
  /** Linear ticket title. */
  title: string;
  /** Assignee email for DM routing. When set, tries to DM the user first; falls back to channel on lookup failure. */
  recipientEmail?: string;
}

const DEFAULT_API_BASE_URL = "https://slack.com/api";

/**
 * Posts notifications to Slack via chat.postMessage. The channel and bot token are
 * supplied by the operator via env vars (see manager/config.ts). Per-tenant channel
 * configuration is future work — for now there is a single workspace-wide channel.
 */
export class SlackIntegration implements Integration {
  readonly name = "slack";
  private readonly token: string;
  private readonly channel: string;
  private readonly apiBaseUrl: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackIntegrationOptions) {
    if (!options.token) {
      throw new Error("SlackIntegration requires a bot token");
    }
    if (!options.channel) {
      throw new Error("SlackIntegration requires a target channel");
    }
    this.token = options.token;
    this.channel = options.channel;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Post a "PR opened" or "PR updated" notification. When `recipientEmail` is set,
   * resolves it to a Slack user ID (DM) via `users.lookupByEmail`; falls back to
   * the configured channel on lookup failure. Failures are logged but never thrown.
   */
  async notifyPullRequest(notification: PullRequestNotification): Promise<void> {
    const text = formatNotificationText(notification);
    const channel = notification.recipientEmail
      ? await this.resolveUserChannel(notification.recipientEmail)
      : this.channel;
    await this.postMessage(channel, text);
  }

  /**
   * Post a "Needs your input" notification when the agent hands a ticket back
   * without a PR (e.g. after respond_to_ticket_reporter). DMs the assignee when
   * `recipientEmail` is set; falls back to the configured channel.
   */
  async notifyNeedsInput(notification: NeedsInputNotification): Promise<void> {
    const text = formatNeedsInputText(notification);
    const channel = notification.recipientEmail
      ? await this.resolveUserChannel(notification.recipientEmail)
      : this.channel;
    await this.postMessage(channel, text);
  }

  private async resolveUserChannel(email: string): Promise<string> {
    try {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!response.ok) {
        this.logger.warn(
          { status: response.status, email },
          "slack users.lookupByEmail HTTP error; falling back to channel",
        );
        return this.channel;
      }
      const body = (await response.json()) as { ok: boolean; user?: { id: string }; error?: string };
      if (!body.ok || !body.user?.id) {
        this.logger.warn(
          { error: body.error, email },
          "slack users.lookupByEmail returned ok=false; falling back to channel",
        );
        return this.channel;
      }
      return body.user.id;
    } catch (err) {
      this.logger.warn({ err, email }, "slack users.lookupByEmail threw; falling back to channel");
      return this.channel;
    }
  }

  private async postMessage(channel: string, text: string): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      });
      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText, channel },
          "slack chat.postMessage HTTP error",
        );
        return;
      }
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!body.ok) {
        this.logger.error({ error: body.error, channel }, "slack chat.postMessage returned ok=false");
      }
    } catch (err) {
      this.logger.error({ err, channel }, "slack chat.postMessage threw");
    }
  }
}

/**
 * Escape characters that have special meaning in Slack mrkdwn so that
 * untrusted text (e.g. PR titles or ticket ids generated by an AI agent)
 * can't smuggle in `<url|label>` links or otherwise distort the message.
 * See https://api.slack.com/reference/surfaces/formatting#escaping.
 */
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatNotificationText(notification: PullRequestNotification): string {
  const { kind, pr, title, url, ticketId, ticketUrl } = notification;
  if (!url.startsWith("https://")) throw new Error(`Invalid PR URL: ${url}`);
  if (!ticketUrl.startsWith("https://")) throw new Error(`Invalid ticket URL: ${ticketUrl}`);
  const safeTitle = escapeSlackMrkdwn(title);
  const safeTicketId = escapeSlackMrkdwn(ticketId);
  const prLink = `<${url}|${escapeSlackMrkdwn(pr.owner)}/${escapeSlackMrkdwn(pr.repo)}#${pr.number}>`;
  const ticketLabel = `<${ticketUrl}|${safeTicketId}>`;
  if (kind === "opened") {
    return `:bear: PR opened ${prLink} for ticket ${ticketLabel} — ${safeTitle}`;
  }
  return `Updated PR ${prLink} for ticket ${ticketLabel} — ${safeTitle}`;
}

export function formatNeedsInputText(notification: NeedsInputNotification): string {
  const { ticketId, ticketUrl, title } = notification;
  if (!ticketUrl.startsWith("https://")) throw new Error(`Invalid ticket URL: ${ticketUrl}`);
  const safeTicketId = escapeSlackMrkdwn(ticketId);
  const safeTitle = escapeSlackMrkdwn(title);
  const ticketLabel = `<${ticketUrl}|${safeTicketId}>`;
  return `:raising_hand: Needs your input on ticket ${ticketLabel} — ${safeTitle}`;
}
