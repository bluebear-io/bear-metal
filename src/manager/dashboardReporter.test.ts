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
    recordEvent: vi.fn().mockResolvedValue(undefined),
    recordRunLog: vi.fn().mockResolvedValue(undefined),
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
  it("writes the PR row keyed owner/repo#number, sets pr_open, emits pr_opened", async () => {
    const c = fakeClient();
    const pr = { owner: "o", repo: "r", number: 7, title: "PR", headRef: "h", state: "open" as const, draft: false, merged: false, url: "purl" };
    await make(c).prOpened(ticket, pr);
    expect(c.upsertPullRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "o/r#7", ticketId: "lin_1", number: 7, state: "open" }));
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "pr_open" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "pr_opened" }));
  });
});
