import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerListItem } from "../api/types.js";
import WorkersPage from "./WorkersPage.js";

const useWorkers = vi.fn();

vi.mock("../api/queries.js", () => ({
  useWorkers: () => useWorkers(),
}));

const workers: WorkerListItem[] = [
  {
    id: "worker-1",
    name: "worker-1",
    status: "busy",
    currentRunId: "run-1",
    lastHeartbeatAt: "2026-06-09T10:06:00.000Z",
    startedAt: "2026-06-09T10:00:00.000Z",
    updatedAt: "2026-06-09T10:06:00.000Z",
    currentTicketIdentifier: "DEN-3004",
    currentTicketTitle: "Investigate manager dispatch",
    currentRun: {
      id: "run-1",
      attemptNumber: 1,
      status: "running",
      trigger: "new",
      workerId: "worker-1",
      stopReason: null,
      startedAt: "2026-06-09T10:00:00.000Z",
      endedAt: null,
      createdAt: "2026-06-09T10:00:00.000Z",
      ticketId: "ticket-1",
      ticketIdentifier: "DEN-3004",
      ticketTitle: "Investigate manager dispatch",
      runtimeMs: 360_000,
    },
    heartbeatAgeMs: 30_000,
    isDead: false,
    isHeartbeatStale: false,
    isTimedOut: false,
  },
  {
    id: "worker-3",
    name: "worker-3",
    status: "dead",
    currentRunId: null,
    lastHeartbeatAt: null,
    startedAt: "2026-06-09T09:00:00.000Z",
    updatedAt: "2026-06-09T09:20:00.000Z",
    currentTicketIdentifier: null,
    currentTicketTitle: null,
    currentRun: null,
    heartbeatAgeMs: null,
    isDead: true,
    isHeartbeatStale: false,
    isTimedOut: false,
  },
];

describe("WorkersPage", () => {
  beforeEach(() => {
    useWorkers.mockReturnValue({
      data: workers,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });
  });

  it("renders workers with ticket, run, runtime, and health status", () => {
    render(<WorkersPage />);

    expect(screen.getByRole("heading", { name: "Workers" })).toBeVisible();
    expect(screen.getByText("worker-1")).toBeVisible();
    expect(screen.getByText("busy")).toBeVisible();
    expect(screen.getByText("DEN-3004")).toBeVisible();
    expect(screen.getByText("running")).toBeVisible();
    expect(screen.getByText("6m")).toBeVisible();
    expect(screen.getByText("healthy")).toBeVisible();
    expect(screen.getAllByText("dead")).toHaveLength(2);
  });
});
