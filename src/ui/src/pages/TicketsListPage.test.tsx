import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/utils.js";
import type { BmStatus, TicketListItem } from "../api/types.js";
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

function makeTicket(id: string, identifier: string, bmStatus: BmStatus): TicketListItem {
  return { ...mockTicket, id, identifier, bmStatus, latestRun: null, latestPr: null, latestCiStatus: null };
}

const multipleTickets: TicketListItem[] = [
  makeTicket("ticket_done", "DEN-1", "completed"),
  makeTicket("ticket_progress", "DEN-2", "in_progress"),
  makeTicket("ticket_pr", "DEN-3", "pr_open"),
  makeTicket("ticket_ci_failed", "DEN-4", "ci_failed"),
  makeTicket("ticket_abandoned", "DEN-5", "abandoned"),
  makeTicket("ticket_backlog", "DEN-6", "discovered"),
];

let mockData: TicketListItem[] = [mockTicket];

vi.mock("../api/queries.js", () => ({
  useTickets: () => ({
    get data() {
      return mockData;
    },
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

describe("TicketsListPage", () => {
  beforeEach(() => {
    mockData = [mockTicket];
  });

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

  it("filters tickets by bm status category", () => {
    mockData = multipleTickets;
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
    mockData = [makeTicket("ticket_done", "DEN-1", "completed")];
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.click(screen.getByRole("button", { name: /Backlog/ }));
    expect(screen.getByText("No tickets match this filter.")).toBeVisible();
  });
});
