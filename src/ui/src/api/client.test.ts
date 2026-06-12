import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAnalytics, fetchTicketDetail, fetchTickets, fetchWorkers } from "./client.js";
import type { AnalyticsSummary, TicketDetail, TicketListItem, WorkerListItem } from "./types.js";

const mockFetch = (body: unknown, init?: { ok?: boolean; status?: number }) => {
  const response = {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
};

const ticket: TicketListItem = {
  id: "ticket_1",
  identifier: "DEN-2271",
  title: "Add API client",
  description: null,
  url: "https://linear.app/blueden/issue/DEN-2271",
  branchName: "codex/den-2271",
  linearStatusName: "Todo",
  linearStatusType: "unstarted",
  labelsJson: "[]",
  bmStatus: "abandoned",
  attemptCount: 1,
  maxAttempts: 3,
  createdAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:05:00.000Z",
  completedAt: null,
  latestRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "failed",
    trigger: "new",
    workerId: "worker_1",
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: "2026-06-09T10:04:00.000Z",
    createdAt: "2026-06-09T10:01:00.000Z",
  },
  latestPr: { number: 14, url: "https://github.com/acme/repo/pull/14", state: "open", merged: false },
  latestCiStatus: "failed",
};

const detail: TicketDetail = {
  ticket,
  runs: [],
  pullRequests: [],
  ciRuns: [],
  events: [],
};

const worker: WorkerListItem = {
  id: "worker_1",
  name: "runner-1",
  status: "busy",
  currentRunId: "run_1",
  lastHeartbeatAt: "2026-06-09T10:07:00.000Z",
  startedAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:07:00.000Z",
  currentTicketIdentifier: "DEN-2271",
  currentTicketTitle: "Add API client",
  currentRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "running",
    trigger: "new",
    workerId: "worker_1",
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: null,
    createdAt: "2026-06-09T10:01:00.000Z",
    ticketId: "ticket_1",
    ticketIdentifier: "DEN-2271",
    ticketTitle: "Add API client",
    runtimeMs: 360000,
  },
  heartbeatAgeMs: 5000,
  isDead: false,
  isHeartbeatStale: false,
  isTimedOut: false,
};

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchTickets returns tickets and passes the status query", async () => {
    mockFetch({ tickets: [ticket] });

    await expect(fetchTickets("abandoned")).resolves.toEqual([ticket]);

    expect(fetch).toHaveBeenCalledWith("/api/tickets?status=abandoned");
  });

  it("fetchTickets calls the ticket collection path without a status", async () => {
    mockFetch({ tickets: [] });

    await expect(fetchTickets()).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledWith("/api/tickets");
  });

  it("fetchTicketDetail returns the detail body", async () => {
    mockFetch(detail);

    await expect(fetchTicketDetail("lin_2")).resolves.toEqual(detail);

    expect(fetch).toHaveBeenCalledWith("/api/tickets/lin_2");
  });

  it("fetchTicketDetail URL-encodes IDs with spaces and slashes", async () => {
    mockFetch(detail);

    await fetchTicketDetail("lin 2/child");

    expect(fetch).toHaveBeenCalledWith("/api/tickets/lin%202%2Fchild");
  });

  it("fetchWorkers throws on non-OK responses with the path and HTTP status", async () => {
    mockFetch({ error: "nope" }, { ok: false, status: 500 });

    await expect(fetchWorkers()).rejects.toThrow(/\/api\/workers.*500/);
  });

  it("fetchAnalytics returns the analytics body and calls the analytics path", async () => {
    const analytics: AnalyticsSummary = {
      generatedAt: "2026-06-09T09:00:00.000Z",
      outcomes: { total: 1, completed: 1, abandoned: 0, inFlight: 0, successRate: 1, abandonmentRate: 0 },
      attemptsDistribution: [{ attempts: 1, count: 1 }],
      mttr: { sampleSize: 1, meanMs: 1000, medianMs: 1000, p90Ms: 1000 },
      throughput: [{ date: "2026-06-09", created: 1, completed: 1 }],
    };
    mockFetch(analytics);

    await expect(fetchAnalytics()).resolves.toEqual(analytics);

    expect(fetch).toHaveBeenCalledWith("/api/analytics");
  });

  it("fetchWorkers returns workers with current-run and health fields", async () => {
    mockFetch({ workers: [worker] });

    await expect(fetchWorkers()).resolves.toEqual([worker]);

    expect(fetch).toHaveBeenCalledWith("/api/workers");
  });
});
