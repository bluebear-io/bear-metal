import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/utils.js";
import type { TicketListItem } from "../api/types.js";
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

vi.mock("../api/queries.js", () => ({
  useTickets: () => ({
    data: [mockTicket],
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
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
});
