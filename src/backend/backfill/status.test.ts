import { describe, expect, it } from "vitest";
import { type BmStatusPrInput, deriveBmStatus } from "./status.js";

const openPr = (latestCiStatus: BmStatusPrInput["latestCiStatus"] = null): BmStatusPrInput => ({
  merged: false,
  state: "open",
  latestCiStatus,
});

const mergedPr = (): BmStatusPrInput => ({
  merged: true,
  state: "closed",
  latestCiStatus: "passed",
});

const closedUnmergedPr = (): BmStatusPrInput => ({
  merged: false,
  state: "closed",
  latestCiStatus: null,
});

describe("deriveBmStatus", () => {
  it("returns completed when any PR is merged", () => {
    expect(deriveBmStatus({ linearStatusType: "completed", prs: [mergedPr()] })).toBe("completed");
  });

  it("returns completed when a merged PR coexists with an open one", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [openPr(), mergedPr()] })).toBe(
      "completed",
    );
  });

  it("returns ci_failed when an open PR has a failed CI", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [openPr("failed")] })).toBe(
      "ci_failed",
    );
  });

  it("returns ci_running when an open PR has a running CI", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [openPr("running")] })).toBe(
      "ci_running",
    );
  });

  it("returns pr_open when an open PR has a passing CI", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [openPr("passed")] })).toBe(
      "pr_open",
    );
  });

  it("returns pr_open when an open PR has no CI yet", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [openPr(null)] })).toBe("pr_open");
  });

  it("returns abandoned when every PR is closed without merging", () => {
    expect(
      deriveBmStatus({ linearStatusType: "canceled", prs: [closedUnmergedPr()] }),
    ).toBe("abandoned");
  });

  it("returns abandoned when there is no PR and Linear is canceled", () => {
    expect(deriveBmStatus({ linearStatusType: "canceled", prs: [] })).toBe("abandoned");
  });

  it("returns in_progress when there is no PR and Linear is started", () => {
    expect(deriveBmStatus({ linearStatusType: "started", prs: [] })).toBe("in_progress");
  });

  it("returns discovered when there is no PR and Linear is unstarted", () => {
    expect(deriveBmStatus({ linearStatusType: "unstarted", prs: [] })).toBe("discovered");
  });

  it("returns discovered when there is no PR and the Linear state type is something unexpected", () => {
    expect(deriveBmStatus({ linearStatusType: "triage", prs: [] })).toBe("discovered");
  });
});
