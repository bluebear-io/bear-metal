const PRIVATE_KEY = /-----BEGIN(?: RSA)? PRIVATE KEY-----[\s\S]*?-----END(?: RSA)? PRIVATE KEY-----/gi;
const AUTHORIZATION = /(authorization\s*[:=]\s*(?:bearer|token|basic)\s+)[^\s,"'}]+/gi;
const NAMED_SECRET = /((?:client_secret|private_key|access_token|refresh_token|bot_token)\s*[=:]\s*)[^&\s,"'}]+/gi;
const TOKEN = /\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g;
const SIGNED_URL_PARAMETER = /([?&](?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|sig|token)=)[^&#\s]+/gi;

export function redactCredentials(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[REDACTED]")
    .replace(AUTHORIZATION, "$1[REDACTED]")
    .replace(NAMED_SECRET, "$1[REDACTED]")
    .replace(TOKEN, "[REDACTED]")
    .replace(SIGNED_URL_PARAMETER, "$1[REDACTED]");
}
