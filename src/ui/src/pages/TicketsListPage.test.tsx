import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/utils.js";
import type { BmStatus, TicketFilterOptions, TicketListItem, TicketListQuery, TicketListResponse } from "../api/types.js";
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
  createdAt: "2026-06-09T10:00:00.000Z",
  updatedAt: "2026-06-09T10:05:00.000Z",
  completedAt: "2026-06-09T10:04:00.000Z",
  latestRun: {
    id: "run_1",
    attemptNumber: 1,
    status: "succeeded",
    trigger: "new",
    workerId: "worker_1",
    stopReason: "completed",
    startedAt: "2026-06-09T10:01:00.000Z",
    endedAt: "2026-06-09T10:04:00.000Z",
    createdAt: "2026-06-09T10:01:00.000Z",
  },
  latestWorkerName: "worker-1",
  latestPr: { number: 42, url: "https://github.com/blueden/bear-metal/pull/42", state: "open", merged: false },
  latestCiStatus: "passed",
};

function makeTicket(id: string, identifier: string, bmStatus: BmStatus): TicketListItem {
  return { ...mockTicket, id, identifier, bmStatus, latestRun: null, latestWorkerName: null, latestPr: null, latestCiStatus: null };
}

const multipleTickets: TicketListItem[] = [
  makeTicket("ticket_done", "DEN-1", "completed"),
  makeTicket("ticket_progress", "DEN-2", "in_progress"),
  makeTicket("ticket_pr", "DEN-3", "pr_open"),
  makeTicket("ticket_ci_failed", "DEN-4", "ci_failed"),
  makeTicket("ticket_abandoned", "DEN-5", "abandoned"),
  makeTicket("ticket_backlog", "DEN-6", "discovered"),
];

const filterOptions: TicketFilterOptions = {
  bmStatuses: ["completed", "abandoned", "in_progress"],
  stopReasons: ["completed", "timeout"],
  labels: ["bear-metal", "module:bff"],
  workers: [{ id: "worker_1", name: "worker-1" }, { id: "worker_2", name: "worker-2" }],
};

let mockTickets: TicketListItem[] = [mockTicket];
const lastQuery: { value: TicketListQuery | undefined } = { value: undefined };

function makeResponse(tickets: TicketListItem[]): TicketListResponse {
  return { tickets, total: tickets.length, page: 1, pageSize: 50 };
}

vi.mock("../api/queries.js", () => ({
  useTickets: (q: TicketListQuery) => {
    lastQuery.value = q;
    return {
      get data() {
        const tickets = q.bmStatuses
          ? mockTickets.filter((t) => q.bmStatuses!.includes(t.bmStatus))
          : mockTickets;
        return makeResponse(tickets);
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    };
  },
  useTicketFilterOptions: () => ({
    data: filterOptions,
    error: null,
    isLoading: false,
    isFetching: false,
  }),
  useConfig: () => ({
    data: { maxIterations: 5 },
    error: null,
    isLoading: false,
    isFetching: false,
  }),
}));

describe("TicketsListPage", () => {
  beforeEach(() => {
    mockTickets = [mockTicket];
    lastQuery.value = undefined;
  });

  it("renders ticket status, latest run, attempts, worker, and PR link", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    expect(screen.getByRole("heading", { name: "Tickets" })).toBeVisible();
    const list = screen.getByRole("region", { name: "Tickets list" });
    expect(within(list).getByRole("link", { name: "DEN-2271" })).toHaveAttribute("href", "https://linear.app/blueden/issue/DEN-2271");
    expect(within(list).getByText("completed")).toBeVisible();
    expect(within(list).getByText("succeeded")).toBeVisible();
    expect(within(list).getByText("1/5")).toBeVisible();
    expect(within(list).getByText("worker-1")).toBeVisible();
    expect(within(list).getByRole("link", { name: "#42" })).toHaveAttribute(
      "href",
      "https://github.com/blueden/bear-metal/pull/42",
    );
  });

  it("filters tickets by bm status category", () => {
    mockTickets = multipleTickets;
    renderWithProviders(<TicketsListPage />, "/tickets");

    const list = screen.getByRole("region", { name: "Tickets list" });

    // All by default.
    expect(within(list).getAllByRole("row")).toHaveLength(multipleTickets.length + 1); // +1 for the header row.

    fireEvent.click(screen.getByRole("button", { name: /Completed/ }));
    expect(within(list).getByRole("link", { name: "DEN-1" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "DEN-2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /In progress/ }));
    expect(within(list).getByRole("link", { name: "DEN-2" })).toBeVisible();
    expect(within(list).getByRole("link", { name: "DEN-3" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "DEN-1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Needs human/ }));
    expect(within(list).getByRole("link", { name: "DEN-4" })).toBeVisible();
    expect(within(list).getByRole("link", { name: "DEN-5" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "DEN-2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    expect(within(list).getByRole("link", { name: "DEN-6" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "DEN-1" })).toBeNull();
  });

  it("shows empty state when filter has no matches", () => {
    mockTickets = [makeTicket("ticket_done", "DEN-1", "completed")];
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    expect(screen.getByText("No tickets match these filters.")).toBeVisible();
  });

  it("submits free-text searches via the query layer", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.change(screen.getByPlaceholderText(/Search tickets/), { target: { value: "flaky" } });
    fireEvent.submit(screen.getByRole("search"));

    expect(lastQuery.value?.q).toBe("flaky");
    expect(lastQuery.value?.page).toBe(1);
  });

  it("populates dropdowns from filter options and pushes selections into the query", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    const workerSelect = screen.getByLabelText("Filter by worker") as HTMLSelectElement;
    expect(within(workerSelect).getByRole("option", { name: "worker-2" })).toBeInTheDocument();
    fireEvent.change(workerSelect, { target: { value: "worker_2" } });
    expect(lastQuery.value?.workerIds).toEqual(["worker_2"]);

    const labelSelect = screen.getByLabelText("Filter by label") as HTMLSelectElement;
    fireEvent.change(labelSelect, { target: { value: "module:bff" } });
    expect(lastQuery.value?.labels).toEqual(["module:bff"]);

    const stateSelect = screen.getByLabelText("Filter by state") as HTMLSelectElement;
    fireEvent.change(stateSelect, { target: { value: "abandoned" } });
    expect(lastQuery.value?.bmStatuses).toEqual(["abandoned"]);

    const stopSelect = screen.getByLabelText("Filter by failure reason") as HTMLSelectElement;
    fireEvent.change(stopSelect, { target: { value: "timeout" } });
    expect(lastQuery.value?.stopReasons).toEqual(["timeout"]);
  });
});
