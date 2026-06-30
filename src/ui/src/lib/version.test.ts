import { describe, expect, it } from "vitest";

import { formatAppVersion } from "./version.js";

describe("formatAppVersion", () => {
  it("adds a leading v only when the version does not already include one", () => {
    expect(formatAppVersion("1.2.3")).toBe("v1.2.3");
    expect(formatAppVersion("v1.2.3")).toBe("v1.2.3");
  });
});
