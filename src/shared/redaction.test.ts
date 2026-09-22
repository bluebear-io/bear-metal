import { describe, expect, it } from "vitest";

import { redactCredentials } from "./redaction.js";

describe("redactCredentials", () => {
  it("redacts credentials and signed URL parameters", () => {
    const value = "Authorization: Bearer secret-token client_secret=client-value https://example.com/file?X-Amz-Signature=signed&safe=yes -----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----";
    const redacted = redactCredentials(value);
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("client-value");
    expect(redacted).not.toContain("signed");
    expect(redacted).not.toContain("private");
    expect(redacted).toContain("[REDACTED]");
  });
});
