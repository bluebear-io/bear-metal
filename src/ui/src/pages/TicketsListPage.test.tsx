import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/utils.js";
import type { TicketFilters, TicketListItem, TicketsResponse } from "../api/types.js";
import TicketsListPage from "./TicketsListPage.js";

const mockTicket: TicketListItem = {
  id: "ticket_1",
  identifier: "DEN-2271",
  title: "Tickets list page",
  description: null,
  url: "https://linear.app/blueden/issue/DEN-2271",
  branchName: "codex/den-2271-u3",
  linearStatusName: "Done",
  linearStatusType: "completed",
  labelsJson: "[]",
  bmStatus: "completed",
  attemptCount: 1,
  maxAttempts: 5,
  createdAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:05:00.000Z",
  completedAt: "2026-06-09T10:04:00.000Z",
  latestRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "succeeded",
    trigger: "new",
    workerId: "worker_1",
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: "2026-06-09T10:04:00.000Z",
    createdAt: "2026-06-09T10:01:00.000Z",
  },
  latestPr: { number: 42, url: "https://github.com/blueden/bear-metal/pull/42", state: "open", merged: false },
  latestCiStatus: "passed",
};

const ticketsResponse: TicketsResponse = {
  tickets: [mockTicket],
  total: 1,
  page: 1,
  pageSize: 25,
};

const useTicketsSpy = vi.fn();

vi.mock("../api/queries.js", () => ({
  useTickets: (filters: TicketFilters) => {
    useTicketsSpy(filters);
    return {
      data: ticketsResponse,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useTicketFilterOptions: () => ({
    data: {
      bmStatuses: ["discovered", "completed", "abandoned", "ci_failed"],
      stopReasons: ["completed", "timeout"],
      labels: ["bear-metal", "module:bff"],
      defaultPageSize: 25,
      maxPageSize: 200,
    },
    error: null,
    isFetching: false,
    isLoading: false,
  }),
  useWorkers: () => ({
    data: [
      {
        id: "worker_1",
        name: "runner-1",
        status: "busy",
        currentRunId: null,
        lastHeartbeatAt: null,
        startedAt: "2026-06-09T10:00:00.000Z",
        updatedAt: "2026-06-09T10:07:00.000Z",
        currentTicketIdentifier: null,
        currentTicketTitle: null,
        currentRun: null,
        heartbeatAgeMs: null,
        isDead: false,
        isHeartbeatStale: false,
        isTimedOut: false,
      },
    ],
    error: null,
    isFetching: false,
    isLoading: false,
  }),
}));

describe("TicketsListPage", () => {
  it("renders ticket status, latest run, attempts, and PR link", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    expect(screen.getByRole("heading", { name: "Tickets" })).toBeVisible();
    expect(screen.getByRole("link", { name: "DEN-2271" })).toHaveAttribute("href", "/tickets/ticket_1");
    expect(screen.getByText("completed")).toBeVisible();
    expect(screen.getByText("succeeded")).toBeVisible();
    expect(screen.getByText("1/5")).toBeVisible();
    expect(screen.getByRole("link", { name: "#42" })).toHaveAttribute(
      "href",
      "https://github.com/blueden/bear-metal/pull/42",
    );
  });

  it("exposes search, filter dropdowns, and pagination controls", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    expect(screen.getByLabelText(/^Search$/i)).toBeVisible();
    expect(screen.getByLabelText(/Error signature/i)).toBeVisible();
    expect(screen.getByLabelText(/^State$/i)).toBeVisible();
    expect(screen.getByLabelText(/^Worker$/i)).toBeVisible();
    expect(screen.getByLabelText(/^Label$/i)).toBeVisible();
    expect(screen.getByLabelText(/Failure \/ stop reason/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText(/1 match/)).toBeVisible();
  });

  it("submits applied filters into the tickets query", () => {
    useTicketsSpy.mockClear();
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.change(screen.getByLabelText(/^Search$/i), { target: { value: "  flaky  " } });
    fireEvent.change(screen.getByLabelText(/Error signature/i), { target: { value: "wall clock" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const last = useTicketsSpy.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({
      search: "flaky",
      errorSignature: "wall clock",
      page: 1,
      pageSize: 25,
    });
  });
});
