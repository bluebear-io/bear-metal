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

export type PullRequestNotificationKind = "opened" | "updated" | "validation_delayed";

export interface PullRequestNotificationItem {
  pr: PullRequestRef;
  /** PR HTML url. */
  url: string;
}

export interface PullRequestNotification {
  kind: PullRequestNotificationKind;
  /** PRs to include in the notification. Single-PR keeps the legacy wording; multi-PR lists every link in one message. */
  prs: PullRequestNotificationItem[];
  /** Linear ticket title. */
  title: string;
  /** Originating Linear ticket identifier (e.g. "PROJ-4"). */
  ticketId: string;
  ticketUrl: string;
  /** Required for validation-delayed notifications. */
  validationWaitMinutes?: number;
  /** Assignee email for DM routing. When set, tries to DM the user first; falls back to channel on lookup failure. */
  recipientEmail?: string;
}

export interface NeedsInputNotification {
  /** Linear ticket identifier (e.g. "PROJ-4"). */
  ticketId: string;
  ticketUrl: string;
  /** Linear ticket title. */
  title: string;
  /** Assignee email for DM routing. When set, tries to DM the user first; falls back to channel on lookup failure. */
  recipientEmail?: string;
}

export interface MaxIterationsReachedNotification {
  /** Linear ticket identifier (e.g. "PROJ-4"). */
  ticketId: string;
  ticketUrl: string;
  /** Linear ticket title. */
  title: string;
  /** The configured iteration cap that was hit. */
  maxIterations: number;
  /** Assignee email for DM routing. When set, tries to DM the user first; falls back to channel on lookup failure. */
  recipientEmail?: string;
}

const DEFAULT_API_BASE_URL = "https://slack.com/api";

export interface SlackReadClientOptions {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SlackReadClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackReadClientOptions) {
    if (!options.token) throw new Error("SlackReadClient requires a bot token");
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(
    method: string,
    params: Readonly<Record<string, string | number | boolean>> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (!/^[a-z]+\.[a-zA-Z]+$/.test(method)) throw new Error(`Invalid Slack API method: ${method}`);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) query.set(key, String(value));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await this.fetchImpl(`${this.apiBaseUrl}/${method}${suffix}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Slack API request failed: ${response.status} ${response.statusText}`.trim());
    return response.json();
  }

  async downloadFile(url: string, options: { signal?: AbortSignal; maxRedirects?: number } = {}): Promise<Response> {
    let current = new URL(url);
    const maxRedirects = options.maxRedirects ?? 3;
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      const response = await this.fetchImpl(current, {
        redirect: "manual",
        signal: options.signal,
        headers: current.origin === new URL(url).origin ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (redirects === maxRedirects) throw new Error("Slack file download exceeded redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("Slack file download redirect omitted location");
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password || !(next.hostname === "slack.com" || next.hostname.endsWith(".slack.com"))) {
        throw new Error("Slack file download redirected to an untrusted host");
      }
      current = next;
    }
    throw new Error("Slack file download exceeded redirect limit");
  }
}

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

  async notifyPullRequest(notification: PullRequestNotification): Promise<void> {
    const text = formatNotificationText(notification);
    const prRefs = notification.prs.map(({ pr }) => ({ owner: pr.owner, repo: pr.repo, number: pr.number }));
    const { channel, destinationType } = await this.selectChannel(notification.recipientEmail, {
      ticketId: notification.ticketId,
      notificationKind: notification.kind,
      prRefs,
    });
    await this.postMessage(channel, text, {
      ticketId: notification.ticketId,
      notificationKind: notification.kind,
      destinationType,
      prRefs,
    });
  }

  async notifyNeedsInput(notification: NeedsInputNotification): Promise<void> {
    const text = formatNeedsInputText(notification);
    const { channel, destinationType } = await this.selectChannel(notification.recipientEmail, {
      ticketId: notification.ticketId,
      notificationKind: "needs_input",
    });
    await this.postMessage(channel, text, {
      ticketId: notification.ticketId,
      notificationKind: "needs_input",
      destinationType,
    });
  }

  async notifyMaxIterationsReached(notification: MaxIterationsReachedNotification): Promise<void> {
    const text = formatMaxIterationsReachedText(notification);
    const { channel, destinationType } = await this.selectChannel(notification.recipientEmail, {
      ticketId: notification.ticketId,
      notificationKind: "max_iterations_reached",
    });
    await this.postMessage(channel, text, {
      ticketId: notification.ticketId,
      notificationKind: "max_iterations_reached",
      destinationType,
    });
  }

  private async selectChannel(
    recipientEmail: string | undefined,
    logCtx: PostLogContext,
  ): Promise<{ channel: string; destinationType: "dm" | "channel" }> {
    if (!recipientEmail) {
      this.logger.debug(
        { ...logCtx, destinationType: "channel", stage: "decision" },
        "slack notification decision: no recipient email; will post to channel",
      );
      return { channel: this.channel, destinationType: "channel" };
    }
    const resolved = await this.resolveUserChannel(recipientEmail, logCtx);
    this.logger.debug(
      { ...logCtx, destinationType: resolved.destinationType, stage: "decision" },
      "slack notification decision",
    );
    return resolved;
  }

  private async resolveUserChannel(
    email: string,
    logCtx: PostLogContext,
  ): Promise<{ channel: string; destinationType: "dm" | "channel" }> {
    try {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      if (!response.ok) {
        this.logger.warn(
          { ...logCtx, httpStatus: response.status, email },
          "slack users.lookupByEmail HTTP error; falling back to channel",
        );
        return { channel: this.channel, destinationType: "channel" };
      }
      const body = (await response.json()) as { ok: boolean; user?: { id: string }; error?: string };
      if (!body.ok || !body.user?.id) {
        this.logger.warn(
          { ...logCtx, slackError: body.error, email },
          "slack users.lookupByEmail returned ok=false; falling back to channel",
        );
        return { channel: this.channel, destinationType: "channel" };
      }
      return { channel: body.user.id, destinationType: "dm" };
    } catch (err) {
      this.logger.warn({ ...logCtx, err, email }, "slack users.lookupByEmail threw; falling back to channel");
      return { channel: this.channel, destinationType: "channel" };
    }
  }

  private async postMessage(channel: string, text: string, logCtx: PostLogContext): Promise<void> {
    // Never log `text` (message body) or the bearer token — logCtx carries only ids/kinds.
    this.logger.info({ ...logCtx, stage: "attempting" }, "slack chat.postMessage attempt");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
      });
    } catch (err) {
      this.logger.error({ ...logCtx, stage: "failed", err }, "slack chat.postMessage threw");
      throw new SlackPostMessageError(
        `slack chat.postMessage threw: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    if (!response.ok) {
      this.logger.error(
        { ...logCtx, stage: "failed", httpStatus: response.status, statusText: response.statusText },
        "slack chat.postMessage HTTP error",
      );
      throw new SlackPostMessageError(
        `slack chat.postMessage HTTP error ${response.status} ${response.statusText}`.trim(),
      );
    }
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      this.logger.error(
        { ...logCtx, stage: "failed", slackError: body.error },
        "slack chat.postMessage returned ok=false",
      );
      throw new SlackPostMessageError(`slack chat.postMessage returned ok=false: ${body.error ?? "unknown"}`);
    }
    this.logger.info({ ...logCtx, stage: "sent" }, "slack chat.postMessage sent");
  }
}

interface PostLogContext {
  ticketId: string;
  notificationKind: string;
  destinationType?: "dm" | "channel";
  prRefs?: Array<{ owner: string; repo: string; number: number }>;
}

/**
 * Thrown by SlackIntegration when a chat.postMessage attempt fails (HTTP
 * non-2xx, Slack ok=false, or network/timeout). Callers use the throw to
 * avoid recording success side-effects (e.g. pr.notified_at) for a send
 * that did not land.
 */
export class SlackPostMessageError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = "SlackPostMessageError";
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
  const { kind, prs, title, ticketId, ticketUrl, validationWaitMinutes } = notification;
  if (prs.length === 0) throw new Error("PullRequestNotification requires at least one PR");
  if (!ticketUrl.startsWith("https://")) throw new Error(`Invalid ticket URL: ${ticketUrl}`);
  for (const item of prs) {
    if (!item.url.startsWith("https://")) throw new Error(`Invalid PR URL: ${item.url}`);
  }
  const safeTitle = escapeSlackMrkdwn(title);
  const safeTicketId = escapeSlackMrkdwn(ticketId);
  const ticketLabel = `<${ticketUrl}|${safeTicketId}>`;
  const prLinks = prs.map(({ pr, url }) =>
    `<${url}|${escapeSlackMrkdwn(pr.owner)}/${escapeSlackMrkdwn(pr.repo)}#${pr.number}>`,
  );
  if (kind === "validation_delayed") {
    if (!Number.isInteger(validationWaitMinutes) || validationWaitMinutes! <= 0) {
      throw new Error(`Invalid validationWaitMinutes: ${validationWaitMinutes}`);
    }
    const subject = prs.length === 1 ? `PR ${prLinks[0]!}` : `PRs ${prLinks.join(", ")}`;
    const minuteLabel = validationWaitMinutes === 1 ? "minute" : "minutes";
    return `:hourglass_flowing_sand: ${subject} for ticket ${ticketLabel} — ${safeTitle} has been waiting for CI validation for over ${validationWaitMinutes} ${minuteLabel}. CI is still running; feel free to take a look in the meantime.`;
  }
  if (prs.length === 1) {
    const prLink = prLinks[0]!;
    if (kind === "opened") {
      return `:bear: PR opened ${prLink} for ticket ${ticketLabel} — ${safeTitle}`;
    }
    return `Updated PR ${prLink} for ticket ${ticketLabel} — ${safeTitle}`;
  }
  const header = kind === "opened"
    ? `:bear: PRs opened for ticket ${ticketLabel} — ${safeTitle}`
    : `PRs updated for ticket ${ticketLabel} — ${safeTitle}`;
  return `${header}\n${prLinks.join(", ")}`;
}

export function formatNeedsInputText(notification: NeedsInputNotification): string {
  const { ticketId, ticketUrl, title } = notification;
  if (!ticketUrl.startsWith("https://")) throw new Error(`Invalid ticket URL: ${ticketUrl}`);
  const safeTicketId = escapeSlackMrkdwn(ticketId);
  const safeTitle = escapeSlackMrkdwn(title);
  const ticketLabel = `<${ticketUrl}|${safeTicketId}>`;
  return `:raising_hand: Needs your input on ticket ${ticketLabel} — ${safeTitle}`;
}

export function formatMaxIterationsReachedText(notification: MaxIterationsReachedNotification): string {
  const { ticketId, ticketUrl, title, maxIterations } = notification;
  if (!ticketUrl.startsWith("https://")) throw new Error(`Invalid ticket URL: ${ticketUrl}`);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    throw new Error(`Invalid maxIterations: ${maxIterations}`);
  }
  const safeTicketId = escapeSlackMrkdwn(ticketId);
  const safeTitle = escapeSlackMrkdwn(title);
  const ticketLabel = `<${ticketUrl}|${safeTicketId}>`;
  return `:no_entry: Gave up on ticket ${ticketLabel} after ${maxIterations} iterations — ${safeTitle}. Handed back for human review.`;
}
