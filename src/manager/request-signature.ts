import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Slack's `v0` scheme: `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<body>`, rejected outside five minutes of the timestamp.
 * With `route` (`<METHOD> <path>`), the signed string is `v0:<timestamp>:<route>:<body>`, so a signature is valid for one route only.
 */
export function signRequest(body: Buffer | string, timestamp: string, secret: string, route?: string): string {
  const prefix = route === undefined ? `v0:${timestamp}:` : `v0:${timestamp}:${route}:`;
  return `v0=${createHmac("sha256", secret).update(prefix).update(body).digest("hex")}`;
}

export function verifyRequestSignature(body: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string, route?: string): boolean {
  if (!timestamp || !signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > MAX_CLOCK_SKEW_SECONDS) return false;
  return timingSafeEqual(Buffer.from(signRequest(body, timestamp, secret, route)), Buffer.from(signature));
}
