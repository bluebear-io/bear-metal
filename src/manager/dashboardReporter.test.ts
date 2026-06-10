import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../shared/index.js";
import type { DashboardClient, Ticket } from "../shared/index.js";
import { DashboardReporter } from "./dashboardReporter.js";

const logger = createLogger({ level: "silent", name: "test" });
function fakeClient() {
  return {
    upsertTicket: vi.fn().mockResolvedValue(undefined),
    upsertWorker: vi.fn().mockResolvedValue(undefined),
    upsertRun: vi.fn().mockResolvedValue(undefined),
    upsertPullRequest: vi.fn().mockResolvedValue(undefined),
    upsertCiRun: vi.fn().mockResolvedValue(undefined),
    replaceCiChecks: vi.fn().mockResolvedValue(undefined),
    replaceReviewThreads: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  } satisfies DashboardClient;
}
const ticket: Ticket = {
  id: "lin_1", identifier: "DEN-1", title: "t", description: null, url: "u", branchName: "b",
  status: { name: "Todo", type: "unstarted" }, priority: 0, labels: ["bear-metal"], assignee: null, delegate: { id: "agent" },
};
const make = (c: DashboardClient) => new DashboardReporter({ client: c, logger, maxAttempts: 5, now: () => new Date(1000) });

describe("ticketDiscovered", () => {
  it("upserts the ticket as discovered and emits ticket_discovered", async () => {
    const c = fakeClient();
    await make(c).ticketDiscovered(ticket);
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ id: "lin_1", bmStatus: "discovered", labels: ["bear-metal"], maxAttempts: 5, linearStatusName: "Todo", linearStatusType: "unstarted" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "ticket_discovered", source: "manager", ticketId: "lin_1" }));
  });
});

describe("runDispatched", () => {
  it("writes a dispatched run, marks the ticket dispatched, emits an event", async () => {
    const c = fakeClient();
    await make(c).runDispatched({ ticket, runId: "run_1", workerId: null, attemptNumber: 2, trigger: "ci_failure" });
    expect(c.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1", ticketId: "lin_1", status: "dispatched", trigger: "ci_failure", attemptNumber: 2, createdAt: 1000 }));
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "dispatched", attemptCount: 2 }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "dispatched" }));
  });
});

describe("runStartedById", () => {
  it("marks the run running (and does NOT touch tickets)", async () => {
    const c = fakeClient();
    await make(c).runStartedById("run_1", "lin_1", "wk_1", 1, "new");
    expect(c.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1", ticketId: "lin_1", status: "running", workerId: "wk_1", startedAt: 1000 }));
    expect(c.upsertTicket).not.toHaveBeenCalled();
  });
});

describe("runCrashedById", () => {
  it("marks the run crashed and emits worker_crashed", async () => {
    const c = fakeClient();
    await make(c).runCrashedById("run_1", "lin_1", "wk_1", 1, "new", "boom");
    expect(c.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1", status: "crashed", stopReason: "crash", error: "boom" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "worker_crashed", source: "worker", summary: "boom" }));
  });
});

describe("ciFailed", () => {
  it("sets ticket ci_failed and emits ci_failed", async () => {
    const c = fakeClient();
    await make(c).ciFailed(ticket, "tests failed");
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "ci_failed" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "ci_failed", source: "ci", summary: "tests failed" }));
  });
});

describe("prOpened", () => {
  it("sets pr_open and emits pr_opened (the PR row itself is owned by recordPullRequestObservation)", async () => {
    const c = fakeClient();
    const pr = { owner: "o", repo: "r", number: 7, title: "PR", headRef: "h", state: "open" as const, draft: false, merged: false, url: "purl" };
    await make(c).prOpened(ticket, pr);
    expect(c.upsertPullRequest).not.toHaveBeenCalled();
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "pr_open" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_opened" }));
  });
});

describe("recordPullRequestObservation", () => {
  const pr = { owner: "o", repo: "r", number: 7, title: "PR", headRef: "h", state: "open" as const, draft: false, merged: false, url: "purl" };

  it("persists PR row, all review threads (resolved+unresolved), and skips CI when no failures", async () => {
    const c = fakeClient();
    const context = {
      pullRequest: {},
      headSha: "abcdef1234567890",
      failedCheckRuns: [],
      failedStatuses: [],
      unresolvedReviewThreads: [],
      reviewThreads: [
        { id: "t1", isResolved: false, path: "f.ts", line: 1, comments: [{ id: "c1", databaseId: 1, body: "x", author: "a", url: "u", createdAt: "t", updatedAt: "t", path: "f.ts", line: 1, originalLine: 1, diffHunk: null }] },
        { id: "t2", isResolved: true, path: "g.ts", line: 2, comments: [] },
      ],
      mergeable: true,
    };
    await make(c).recordPullRequestObservation(ticket, pr, context, "run_5");
    expect(c.upsertPullRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "o/r#7", lastRunId: "run_5" }));
    expect(c.replaceReviewThreads).toHaveBeenCalledWith("o/r#7", expect.arrayContaining([
      expect.objectContaining({ id: "t1", isResolved: false, prId: "o/r#7" }),
      expect.objectContaining({ id: "t2", isResolved: true }),
    ]));
    expect(c.upsertCiRun).not.toHaveBeenCalled();
    expect(c.replaceCiChecks).not.toHaveBeenCalled();
  });

  it("persists a failed CI run keyed on PR+SHA with granular failing checks", async () => {
    const c = fakeClient();
    const context = {
      pullRequest: {},
      headSha: "abcdef1234567890",
      failedCheckRuns: [
        {
          checkRun: { id: 9001, name: "ESLint", conclusion: "failure", details_url: "https://gh/job/1", output: { summary: "1 problem" } },
          annotations: [{ path: "f.ts", start_line: 1, message: "oops" }],
        },
      ],
      failedStatuses: [
        { status: { context: "continuous-integration/jenkins", state: "failure", description: "build broke", target_url: "https://j/1" } },
      ],
      unresolvedReviewThreads: [],
      reviewThreads: [],
      mergeable: true,
    };
    await make(c).recordPullRequestObservation(ticket, pr, context, null);
    expect(c.upsertCiRun).toHaveBeenCalledWith(expect.objectContaining({
      id: "o/r#7@abcdef123456",
      status: "failed",
      prId: "o/r#7",
      summary: expect.stringContaining("ESLint"),
    }));
    expect(c.replaceCiChecks).toHaveBeenCalledWith("o/r#7@abcdef123456", expect.arrayContaining([
      expect.objectContaining({ source: "check_run", name: "ESLint", externalId: "9001", summary: "1 problem" }),
      expect.objectContaining({ source: "status", name: "continuous-integration/jenkins", conclusion: "failure" }),
    ]));
  });
});
