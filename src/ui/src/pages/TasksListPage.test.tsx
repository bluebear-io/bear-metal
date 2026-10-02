import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskListItem, TaskListQuery } from "../api/types.js";
import { renderWithProviders } from "../test/utils.js";
import TasksListPage from "./TasksListPage.js";

const coding: TaskListItem = {
  id: "ticket-1", type: "coding", ticketId: "ticket-1", identifier: "DEN-1", title: "Fix parser",
  ticketUrl: "https://linear.app/issue/DEN-1", status: "in_progress", runStatus: "running",
  attemptCount: 2, workerId: "worker-1", assigneeName: "Aviv", createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:01:00.000Z", pullRequests: [{ id: "pr-1", number: 42, title: "Fix parser",
    headRef: "feature/den-1", url: "https://github.com/example/pull/42", state: "open", draft: false, merged: false }],
};
const research: TaskListItem = { ...coding, id: "research-1", type: "research", ticketId: null,
  identifier: null, title: "What is 2 + 2?", ticketUrl: null, status: "coordinated", runStatus: "succeeded",
  attemptCount: 1, workerId: null, assigneeName: null, pullRequests: [] };
const coordinator: TaskListItem = { ...research, id: "coord-1", type: "coordinator",
  title: "Slack thread coordination", status: "succeeded" };

let tasks: TaskListItem[] = [coding, research, coordinator];
let lastQuery: TaskListQuery = {};

vi.mock("../api/queries.js", () => ({
  useTasks: (query: TaskListQuery) => {
    lastQuery = query;
    const filtered = tasks.filter((task) => (!query.type || task.type === query.type)
      && (!query.statuses || query.statuses.includes(task.status)));
    return { data: { pages: [{ tasks: filtered, total: filtered.length, page: 1, pageSize: 20 }] },
      error: null, isLoading: false, isFetching: false, isFetchingNextPage: false,
      hasNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn() };
  },
  useTaskFilterOptions: () => ({ data: { statuses: ["in_progress", "coordinated", "succeeded"],
    workers: [{ id: "worker-1", name: "worker-1" }], labels: ["bear-metal"], stopReasons: ["timeout"] } }),
  useConfig: () => ({ data: { maxIterations: 5 } }),
}));

describe("TasksListPage", () => {
  beforeEach(() => { tasks = [coding, research, coordinator]; lastQuery = {}; });

  it("shows coding tickets, research, and coordination in the existing table", () => {
    renderWithProviders(<TasksListPage />, "/");
    const list = screen.getByRole("region", { name: "Tasks list" });
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
    expect(within(list).getByRole("link", { name: "DEN-1" })).toHaveAttribute("href", coding.ticketUrl);
    expect(within(list).getByText("What is 2 + 2?")).toBeVisible();
    expect(within(list).getByText("Slack thread coordination")).toBeVisible();
    expect(within(list).getByRole("link", { name: "#42" })).toHaveAttribute("href", coding.pullRequests[0]?.url);
  });

  it("filters all task types by state and type", () => {
    renderWithProviders(<TasksListPage />, "/");
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(lastQuery.statuses).toContain("coordinated");
    expect(screen.getByText("What is 2 + 2?")).toBeVisible();
    expect(screen.queryByText("Fix parser")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "research" } });
    expect(lastQuery.type).toBe("research");
  });

  it("searches requests and retains coding filters", () => {
    renderWithProviders(<TasksListPage />, "/");
    fireEvent.change(screen.getByPlaceholderText(/Search tasks/), { target: { value: "parser" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(lastQuery.q).toBe("parser");
    fireEvent.change(screen.getByLabelText("Filter by worker"), { target: { value: "worker-1" } });
    expect(lastQuery.workerId).toBe("worker-1");
    fireEvent.change(screen.getByLabelText("Filter by label"), { target: { value: "bear-metal" } });
    expect(lastQuery.label).toBe("bear-metal");
  });
});
