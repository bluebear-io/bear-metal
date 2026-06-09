import { describe, expect, it } from "vitest";

import { branchMatchesTicket } from "./client.js";

const ticket = { identifier: "DEN-2268", branchName: "feature/den-2268-add-manager-infra" };

describe("branchMatchesTicket", () => {
  it("matches a branch containing the ticket identifier (case-insensitive)", () => {
    expect(branchMatchesTicket("feature/DEN-2268-foo", ticket)).toBe(true);
    expect(branchMatchesTicket("fix/den-2268/bar", ticket)).toBe(true);
  });

  it("matches the Linear-suggested branch name", () => {
    expect(branchMatchesTicket("feature/den-2268-add-manager-infra", ticket)).toBe(true);
  });

  it("does not match an unrelated branch", () => {
    expect(branchMatchesTicket("feature/den-9999-other", ticket)).toBe(false);
    expect(branchMatchesTicket("main", ticket)).toBe(false);
  });
});
