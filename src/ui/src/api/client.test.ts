import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTicketsPath, fetchTicketDetail, fetchTicketFilters, fetchTickets, fetchWorkers } from "./client.js";
import type { TicketDetail, TicketFilterOptions, TicketListItem, WorkerListItem } from "./types.js";

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
  identifier: "PROJ-1",
  title: "Add API client",
  description: null,
  url: "https://linear.app/your-workspace/issue/PROJ-1",
  branchName: "codex/abc-2271",
  linearStatusName: "Todo",
  linearStatusType: "unstarted",
  labelsJson: "[]",
  bmStatus: "completed",
  attemptCount: 1,
  createdAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:05:00.000Z",
  completedAt: null,
  latestRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "failed",
    trigger: "new",
    workerId: "worker_1",
    stopReason: "error",
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: "2026-06-09T10:04:00.000Z",
    createdAt: "2026-06-09T10:01:00.000Z",
  },
  latestWorkerName: "runner-1",
  latestPr: { number: 14, url: "https://github.com/acme/repo/pull/14", state: "open", merged: false },
};

const detail: TicketDetail = {
  ticket,
  runs: [],
  pullRequests: [],
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
  currentTicketIdentifier: "PROJ-1",
  currentTicketTitle: "Add API client",
  currentRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "running",
    trigger: "new",
    workerId: "worker_1",
    stopReason: null,
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: null,
    createdAt: "2026-06-09T10:01:00.000Z",
    ticketId: "ticket_1",
    ticketIdentifier: "PROJ-1",
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

  it("fetchTickets returns the paginated body and passes the legacy status query", async () => {
    const body = { tickets: [ticket], total: 1, page: 1, pageSize: 50 };
    mockFetch(body);

    await expect(fetchTickets("completed")).resolves.toEqual(body);

    expect(fetch).toHaveBeenCalledWith("/api/tickets?status=completed");
  });

  it("fetchTickets calls the ticket collection path without a status", async () => {
    const body = { tickets: [], total: 0, page: 1, pageSize: 50 };
    mockFetch(body);

    await expect(fetchTickets()).resolves.toEqual(body);

    expect(fetch).toHaveBeenCalledWith("/api/tickets");
  });

  it("buildTicketsPath serializes search + filter + pagination params", () => {
    expect(
      buildTicketsPath({
        q: "flaky",
        bmStatuses: ["completed", "in_progress"],
        workerIds: ["wk_1"],
        labels: ["bear-metal"],
        stopReasons: ["timeout"],
        page: 2,
        pageSize: 25,
      }),
    ).toBe(
      "/api/tickets?q=flaky&statuses=completed&statuses=in_progress&workerId=wk_1&label=bear-metal&stopReason=timeout&page=2&pageSize=25",
    );
    expect(buildTicketsPath()).toBe("/api/tickets");
  });

  it("fetchTicketFilters returns the dropdown body", async () => {
    const filters: TicketFilterOptions = {
      bmStatuses: ["completed"],
      statusCounts: {},
      stopReasons: ["timeout"],
      labels: ["bear-metal"],
      workers: [{ id: "wk_1", name: "worker-1" }],
    };
    mockFetch(filters);

    await expect(fetchTicketFilters()).resolves.toEqual(filters);
    expect(fetch).toHaveBeenCalledWith("/api/tickets/filters");
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

  it("fetchWorkers returns workers with current-run and health fields", async () => {
    mockFetch({ workers: [worker] });

    await expect(fetchWorkers()).resolves.toEqual([worker]);

    expect(fetch).toHaveBeenCalledWith("/api/workers");
  });
});
