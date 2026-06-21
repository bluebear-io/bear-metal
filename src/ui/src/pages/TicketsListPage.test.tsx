import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/utils.js";
import type { BmStatus, TicketFilterOptions, TicketListItem, TicketListQuery, TicketListResponse } from "../api/types.js";
import TicketsListPage from "./TicketsListPage.js";

const mockTicket: TicketListItem = {
  id: "ticket_1",
  identifier: "PROJ-1",
  title: "Tickets list page",
  description: null,
  url: "https://linear.app/your-workspace/issue/PROJ-1",
  branchName: "codex/abc-2271-u3",
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
  pullRequests: [
    {
      id: "your-org/bear-metal#42",
      number: 42,
      title: "Tickets list page",
      headRef: "feature/proj-1",
      url: "https://github.com/your-org/bear-metal/pull/42",
      state: "open",
      draft: false,
      merged: false,
    },
    {
      id: "your-org/console#43",
      number: 43,
      title: "Tickets list page console",
      headRef: "feature/proj-1",
      url: "https://github.com/your-org/console/pull/43",
      state: "open",
      draft: false,
      merged: false,
    },
  ],
  assigneeName: null,
};

function makeTicket(id: string, identifier: string, bmStatus: BmStatus): TicketListItem {
  return { ...mockTicket, id, identifier, bmStatus, latestRun: null, latestWorkerName: null, pullRequests: [] };
}

const multipleTickets: TicketListItem[] = [
  makeTicket("ticket_done", "ABC-1", "completed"),
  makeTicket("ticket_progress", "ABC-2", "in_progress"),
  makeTicket("ticket_progress2", "ABC-3", "in_progress"),
  makeTicket("ticket_waiting", "ABC-4", "waiting_for_human"),
  makeTicket("ticket_waiting2", "ABC-5", "waiting_for_human"),
  makeTicket("ticket_validating", "ABC-6", "validating"),
  makeTicket("ticket_failed", "ABC-7", "failed"),
];

const filterOptions: TicketFilterOptions = {
  bmStatuses: ["completed", "in_progress", "waiting_for_human", "failed"],
  statusCounts: {},
  stopReasons: ["completed", "timeout"],
  labels: ["bear-metal", "module:bff"],
  workers: [{ id: "worker_1", name: "worker-1" }, { id: "worker_2", name: "worker-2" }],
};

let mockTickets: TicketListItem[] = [mockTicket];
const lastQuery: { value: TicketListQuery | undefined } = { value: undefined };
let fetchNextPage = vi.fn();
let hasNextPage = false;
let isFetchingNextPage = false;
let triggerIntersection: (() => void) | null = null;

function makeResponse(tickets: TicketListItem[], total = tickets.length, page = 1): TicketListResponse {
  return { tickets, total, page, pageSize: 20 };
}

vi.mock("../api/queries.js", () => ({
  useTickets: (q: TicketListQuery) => {
    lastQuery.value = q;
    return {
      get data() {
        const tickets = q.bmStatuses
          ? mockTickets.filter((t) => q.bmStatuses!.includes(t.bmStatus))
          : mockTickets;
        return {
          pages: [makeResponse(tickets)],
        };
      },
      error: null,
      fetchNextPage,
      hasNextPage,
      isFetchingNextPage,
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
    fetchNextPage = vi.fn();
    hasNextPage = false;
    isFetchingNextPage = false;
    triggerIntersection = null;
    vi.stubGlobal("IntersectionObserver", vi.fn((callback: IntersectionObserverCallback) => {
      triggerIntersection = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        takeRecords: vi.fn(),
      };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders ticket status, latest run, attempts, and PR links", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    expect(screen.getByRole("heading", { name: "Tickets" })).toBeVisible();
    const list = screen.getByRole("region", { name: "Tickets list" });
    expect(within(list).getByRole("link", { name: "PROJ-1" })).toHaveAttribute("href", "https://linear.app/your-workspace/issue/PROJ-1");
    expect(within(list).getByText("completed")).toBeVisible();
    expect(within(list).getByText("succeeded")).toBeVisible();
    expect(within(list).getByText("1/5")).toBeVisible();
    expect(within(list).getByRole("link", { name: "#42" })).toHaveAttribute(
      "href",
      "https://github.com/your-org/bear-metal/pull/42",
    );
    expect(within(list).getByRole("link", { name: "#43" })).toHaveAttribute(
      "href",
      "https://github.com/your-org/console/pull/43",
    );
  });

  it("filters tickets by bm status category", () => {
    mockTickets = multipleTickets;
    renderWithProviders(<TicketsListPage />, "/tickets");

    const list = screen.getByRole("region", { name: "Tickets list" });

    // All by default.
    expect(within(list).getAllByRole("row")).toHaveLength(multipleTickets.length + 1); // +1 for the header row.

    fireEvent.click(screen.getByRole("button", { name: /Completed/ }));
    expect(within(list).getByRole("link", { name: "ABC-1" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "ABC-2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /In progress/ }));
    expect(within(list).getByRole("link", { name: "ABC-2" })).toBeVisible();
    expect(within(list).getByRole("link", { name: "ABC-3" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "ABC-1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Waiting for human/ }));
    expect(within(list).getByRole("link", { name: "ABC-4" })).toBeVisible();
    expect(within(list).getByRole("link", { name: "ABC-5" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "ABC-2" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Validating/ }));
    expect(within(list).getByRole("link", { name: "ABC-6" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "ABC-1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));
    expect(within(list).getByRole("link", { name: "ABC-7" })).toBeVisible();
    expect(within(list).queryByRole("link", { name: "ABC-6" })).toBeNull();
  });

  it("shows empty state when filter has no matches", () => {
    mockTickets = [makeTicket("ticket_done", "ABC-1", "completed")];
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.click(screen.getByRole("button", { name: /Validating/ }));
    expect(screen.getByText("No tickets match these filters.")).toBeVisible();
  });

  it("submits free-text searches via the query layer", () => {
    renderWithProviders(<TicketsListPage />, "/tickets");

    fireEvent.change(screen.getByPlaceholderText(/Search tickets/), { target: { value: "flaky" } });
    fireEvent.submit(screen.getByRole("search"));

    expect(lastQuery.value?.q).toBe("flaky");
    expect(lastQuery.value?.page).toBeUndefined();
    expect(lastQuery.value?.pageSize).toBe(20);
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
    fireEvent.change(stateSelect, { target: { value: "waiting_for_human" } });
    expect(lastQuery.value?.bmStatuses).toEqual(["waiting_for_human"]);

    const stopSelect = screen.getByLabelText("Filter by failure reason") as HTMLSelectElement;
    fireEvent.change(stopSelect, { target: { value: "timeout" } });
    expect(lastQuery.value?.stopReasons).toEqual(["timeout"]);
  });

  it("loads the next ticket page from the bottom sentinel", () => {
    hasNextPage = true;
    renderWithProviders(<TicketsListPage />, "/tickets");

    expect(screen.getByTestId("tickets-scroll-sentinel")).toBeInTheDocument();
    triggerIntersection?.();

    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
});
