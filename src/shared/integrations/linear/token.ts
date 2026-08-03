/**
 * Linear app-actor token minting via the OAuth `client_credentials` grant.
 *
 * Linear app-actor tokens are hard-capped at ~30 days; a manually pasted token silently expires
 * and the manager stops authenticating. The only long-lived credential is the OAuth app's
 * client id + secret, which we exchange for a fresh app-actor token here and re-mint before expiry.
 */

import type { Logger } from "../../logger.js";

const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";

/** Re-mint once the cached token is within this window of its expiry. */
const DEFAULT_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TokenProvider {
  getToken(): Promise<string>;
  /** Drop the cached token so the next getToken() re-mints. Called after an auth failure. */
  invalidate(): void;
}

export interface AppTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Comma-separated OAuth scopes, e.g. "read,write". Must stay stable — Linear revokes all app
   *  tokens when a token is requested with a different scope set. */
  scopes: string;
  /** Overridable for tests. */
  tokenEndpoint?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshWindowMs?: number;
  logger?: Logger;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class AppTokenProvider implements TokenProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: string;
  private readonly tokenEndpoint: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshWindowMs: number;
  private readonly logger: Logger | undefined;

  private cached: CachedToken | undefined;
  /** Dedupes concurrent mints (the scheduler fires many Linear calls per tick). */
  private inflight: Promise<string> | undefined;

  constructor(options: AppTokenProviderOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes;
    this.tokenEndpoint = options.tokenEndpoint ?? LINEAR_TOKEN_ENDPOINT;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.logger = options.logger;
  }

  async getToken(): Promise<string> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt - this.refreshWindowMs) {
      return this.cached.token;
    }
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = undefined;
      });
    }
    try {
      return await this.inflight;
    } catch (error) {
      // A proactive refresh (inside the window) that fails should not take down Linear calls while
      // the current token is still usable — only surface the error once the token has actually expired.
      if (this.cached && now < this.cached.expiresAt) {
        this.logger?.warn(
          { err: error, expiresAt: new Date(this.cached.expiresAt).toISOString() },
          "Linear token proactive refresh failed; falling back to the cached token until it expires",
        );
        return this.cached.token;
      }
      throw error;
    }
  }

  invalidate(): void {
    this.cached = undefined;
    this.inflight = undefined;
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scopes,
    });

    const response = await this.fetchFn(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Linear client_credentials token request failed: ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
      throw new Error("Linear client_credentials token response missing access_token or expires_in");
    }

    this.cached = { token: data.access_token, expiresAt: this.now() + data.expires_in * 1000 };
    return this.cached.token;
  }
}
