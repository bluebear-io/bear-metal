import { describe, expect, it } from "vitest";
import type { Ticket as LinearTicket } from "../../shared/index.js";
import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";
import { BACKFILL_WORKER_ID, mapTicketBundle } from "./mapper.js";
import { type FetchedTicket, prKey } from "./types.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

const makeTicket = (overrides: Partial<LinearTicket> = {}): LinearTicket => ({
  id: "lin_1",
  identifier: "DEN-3001",
  title: "Sample ticket",
  description: null,
  url: "https://linear.app/DEN-3001",
  branchName: "feature/den-3001",
  status: { name: "Done", type: "completed" },
  priority: 0,
  labels: ["bear-metal"],
  assignee: { id: "creator" },
  delegate: { id: "agent" },
  createdAt: T0,
  updatedAt: T2,
  completedAt: null,
  canceledAt: null,
  ...overrides,
});

const makePr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  owner: "acme",
  repo: "widgets",
  number: 100,
  title: "Fix",
  headRef: "feature/den-3001",
  headSha: "sha-100",
  state: "open",
  draft: false,
  merged: false,
  url: "https://github.com/acme/widgets/pull/100",
  createdAt: T1,
  updatedAt: T2,
  mergedAt: null,
  closedAt: null,
  ...overrides,
});

const makeCheck = (overrides: Partial<CheckRun> = {}): CheckRun => ({
  id: 1001,
  name: "lint",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/acme/widgets/runs/1001",
  summary: "All good",
  startedAt: T1,
  completedAt: T2,
  ...overrides,
});

const bundle = (ticket: LinearTicket, prs: PullRequest[], checks: Map<string, CheckRun[]>): FetchedTicket => ({
  ticket,
  prs,
  checkRunsByPrKey: checks,
});

describe("mapTicketBundle", () => {
  it("ticket with no PR + Linear active → discovered, no runs/PRs/CI", () => {
    const r = mapTicketBundle(
      bundle(makeTicket({ status: { name: "Todo", type: "unstarted" } }), [], new Map()),
    );
    expect(r.ticket.bmStatus).toBe("discovered");
    expect(r.ticket.attemptCount).toBe(0);
    expect(r.runs).toHaveLength(0);
    expect(r.pullRequests).toHaveLength(0);
    expect(r.ciRuns).toHaveLength(0);
    expect(r.events.map((e) => e.type)).toEqual(["ticket_discovered"]);
  });

  it("ticket with no PR + Linear canceled → abandoned + one synthetic failed run", () => {
    const r = mapTicketBundle(
      bundle(
        makeTicket({
          status: { name: "Canceled", type: "canceled" },
          canceledAt: T2,
          completedAt: null,
        }),
        [],
        new Map(),
      ),
    );
    expect(r.ticket.bmStatus).toBe("abandoned");
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]?.status).toBe("failed");
    expect(r.runs[0]?.workerId).toBe(BACKFILL_WORKER_ID);
    expect(r.events.map((e) => e.type)).toEqual(["ticket_discovered", "ticket_abandoned"]);
  });

  it("ticket with merged PR + passing CI → completed", () => {
    const pr = makePr({ state: "closed", merged: true, mergedAt: T2 });
    const checks = new Map([[prKey(pr), [makeCheck({ conclusion: "success" })]]]);
    const r = mapTicketBundle(
      bundle(makeTicket({ completedAt: T2, status: { name: "Done", type: "completed" } }), [pr], checks),
    );
    expect(r.ticket.bmStatus).toBe("completed");
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]?.status).toBe("succeeded");
    expect(r.pullRequests).toHaveLength(1);
    expect(r.pullRequests[0]?.id).toBe("pr_acme_widgets_100");
    expect(r.pullRequests[0]?.lastRunId).toBe(r.runs[0]?.id);
    expect(r.ciRuns).toHaveLength(1);
    expect(r.ciRuns[0]?.status).toBe("passed");
    expect(r.events.map((e) => e.type)).toContain("ticket_completed");
    expect(r.events.map((e) => e.type)).toContain("pr_opened");
    expect(r.events.map((e) => e.type)).toContain("ci_passed");
  });

  it("ticket with open PR + failing CI → ci_failed", () => {
    const pr = makePr({ state: "open" });
    const checks = new Map([[prKey(pr), [makeCheck({ conclusion: "failure" })]]]);
    const r = mapTicketBundle(bundle(makeTicket({ status: { name: "In Progress", type: "started" } }), [pr], checks));
    expect(r.ticket.bmStatus).toBe("ci_failed");
    expect(r.ciRuns[0]?.status).toBe("failed");
    expect(r.events.map((e) => e.type)).toContain("ci_failed");
  });

  it("ticket with open PR + no CI → pr_open", () => {
    const pr = makePr({ state: "open" });
    const r = mapTicketBundle(bundle(makeTicket({ status: { name: "In Progress", type: "started" } }), [pr], new Map()));
    expect(r.ticket.bmStatus).toBe("pr_open");
    expect(r.ciRuns).toHaveLength(0);
  });

  it("ticket with closed-unmerged PR (none merged) → abandoned", () => {
    const pr = makePr({ state: "closed", merged: false, closedAt: T2 });
    const r = mapTicketBundle(bundle(makeTicket({ status: { name: "Canceled", type: "canceled" } }), [pr], new Map()));
    expect(r.ticket.bmStatus).toBe("abandoned");
    expect(r.runs[0]?.status).toBe("failed");
  });

  it("uses deterministic synthetic ids", () => {
    const pr = makePr({ number: 42 });
    const checks = new Map([[prKey(pr), [makeCheck({ id: 99 })]]]);
    const r = mapTicketBundle(bundle(makeTicket({ id: "lin_x" }), [pr], checks));
    expect(r.ticket.id).toBe("lin_x");
    expect(r.runs[0]?.id).toBe("run_backfill_lin_x_0");
    expect(r.pullRequests[0]?.id).toBe("pr_acme_widgets_42");
    expect(r.ciRuns[0]?.id).toBe("ci_acme_widgets_99");
    expect(r.events.every((e) => e.id?.startsWith("ev_backfill_lin_x_"))).toBe(true);
  });

  it("sorts multi-PR runs by PR createdAt", () => {
    const pr1 = makePr({ number: 1, createdAt: T1 });
    const pr2 = makePr({ number: 2, createdAt: T0 });
    const r = mapTicketBundle(bundle(makeTicket(), [pr1, pr2], new Map()));
    expect(r.runs.map((rn) => rn.attemptNumber)).toEqual([1, 2]);
    expect(r.runs[0]?.id).toBe("run_backfill_lin_1_0");
    expect(r.pullRequests[0]?.number).toBe(2);
    expect(r.pullRequests[1]?.number).toBe(1);
  });
});
