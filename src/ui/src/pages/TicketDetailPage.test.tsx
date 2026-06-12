import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { TicketDetail } from "../api/types.js";
import { useTicketDetail } from "../api/queries.js";
import { TicketDetailPage } from "./TicketDetailPage.js";

vi.mock("../api/queries.js", () => ({
  useTicketDetail: vi.fn(),
}));

const mockUseTicketDetail = vi.mocked(useTicketDetail);

const ticketDetail: TicketDetail = {
  ticket: {
    id: "lin_2",
    identifier: "DEN-3002",
    title: "Retry failed CI build",
    description: "CI needs another run after fixing the flaky assertion.",
    url: "https://linear.app/blueden/issue/DEN-3002/retry-failed-ci-build",
    branchName: "codex/den-3002-retry-failed-ci-build",
    linearStatusName: "In Progress",
    linearStatusType: "started",
    labelsJson: JSON.stringify(["backend", "ci"]),
    bmStatus: "ci_failed",
    attemptCount: 2,
    maxAttempts: 3,
    createdAt: "2026-06-09T08:00:00.000Z",
    updatedAt: "2026-06-09T09:20:00.000Z",
    completedAt: null,
  },
  runs: [
    {
      id: "run_1",
      ticketId: "lin_2",
      attemptNumber: 1,
      workerId: "worker_1",
      trigger: "new",
      status: "failed",
      contextJson: null,
      startedAt: "2026-06-09T08:05:00.000Z",
      endedAt: "2026-06-09T08:40:00.000Z",
      stopReason: "error",
      error: "Tests failed",
      promptTokens: 50_000,
      completionTokens: 2_000,
      modelName: "claude-sonnet-4",
      provider: "anthropic",
      createdAt: "2026-06-09T08:04:00.000Z",
      worker: {
        id: "worker_1",
        name: "runner-a",
        status: "idle",
        currentRunId: null,
        lastHeartbeatAt: "2026-06-09T08:39:00.000Z",
        startedAt: "2026-06-09T07:30:00.000Z",
        updatedAt: "2026-06-09T08:40:00.000Z",
      },
      toolCalls: [],
    },
    {
      id: "run_2",
      ticketId: "lin_2",
      attemptNumber: 2,
      workerId: "worker_2",
      trigger: "ci_failure",
      status: "running",
      contextJson: null,
      startedAt: "2026-06-09T09:00:00.000Z",
      endedAt: null,
      stopReason: null,
      error: null,
      promptTokens: null,
      completionTokens: null,
      modelName: null,
      provider: null,
      createdAt: "2026-06-09T08:59:00.000Z",
      worker: {
        id: "worker_2",
        name: "runner-b",
        status: "busy",
        currentRunId: "run_2",
        lastHeartbeatAt: "2026-06-09T09:18:00.000Z",
        startedAt: "2026-06-09T08:55:00.000Z",
        updatedAt: "2026-06-09T09:18:00.000Z",
      },
      toolCalls: [],
    },
  ],
  pullRequests: [
    {
      id: "pr_1501",
      ticketId: "lin_2",
      number: 1501,
      title: "DEN-3002 Retry failed CI build",
      headRef: "codex/den-3002-retry-failed-ci-build",
      state: "open",
      draft: false,
      merged: false,
      url: "https://github.com/blueden/bear-metal/pull/1501",
      lastRunId: "run_2",
      createdAt: "2026-06-09T08:45:00.000Z",
      updatedAt: "2026-06-09T09:15:00.000Z",
      reviewThreads: [
        {
          id: "thr_1",
          prId: "pr_1501",
          path: "src/manager/scheduler.ts",
          line: 211,
          isResolved: false,
          commentsJson: JSON.stringify([
            {
              id: "cmt_1",
              body: "Should this guard against null PR?",
              author: "reviewer-a",
              url: "https://github.com/blueden/bear-metal/pull/1501#discussion_r1",
              createdAt: "2026-06-09T08:33:00.000Z",
              updatedAt: "2026-06-09T08:33:00.000Z",
              path: "src/manager/scheduler.ts",
              line: 211,
            },
          ]),
          createdAt: "2026-06-09T08:33:00.000Z",
          updatedAt: "2026-06-09T08:33:00.000Z",
        },
      ],
    },
  ],
  ciRuns: [
    {
      id: "ci_1",
      ticketId: "lin_2",
      runId: "run_2",
      prId: "pr_1501",
      status: "failed",
      url: "https://github.com/blueden/bear-metal/actions/runs/1501",
      summary: "Unit tests failed on retry",
      createdAt: "2026-06-09T09:10:00.000Z",
      completedAt: "2026-06-09T09:18:00.000Z",
      checks: [
        {
          id: "chk_eslint",
          ciRunId: "ci_1",
          source: "check_run",
          externalId: "9001",
          name: "ESLint",
          conclusion: "failure",
          detailsUrl: "https://github.com/blueden/bear-metal/actions/runs/1501/job/9001",
          summary: "1 lint problem",
          annotationsJson: JSON.stringify([
            { path: "src/manager/scheduler.ts", start_line: 122, message: "'reporter' is defined but never used." },
          ]),
          createdAt: "2026-06-09T09:12:00.000Z",
        },
      ],
    },
  ],
  events: [
    {
      id: "event_1",
      ticketId: "lin_2",
      runId: "run_1",
      workerId: "worker_1",
      source: "worker",
      type: "run_failed",
      summary: "Worker reported failing unit tests",
      payloadJson: null,
      createdAt: "2026-06-09T08:40:00.000Z",
    },
  ],
};

const renderPage = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/tickets/lin_2"]}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("TicketDetailPage", () => {
  it("renders ticket detail, runs, PR/CI status, and timeline events", () => {
    mockUseTicketDetail.mockReturnValue({
      data: ticketDetail,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useTicketDetail>);

    renderPage();

    expect(screen.getByText("DEN-3002")).toBeVisible();
    expect(screen.getByText(/attempt 2/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /#1501/i })).toBeVisible();
    expect(screen.getAllByText(/^failed$/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Unit tests failed on retry")).toBeVisible();
    expect(screen.getByText("Worker reported failing unit tests")).toBeVisible();
    // Each timeline row exposes a <time> element with the event timestamp on the right.
    const timelineTime = document.querySelector('time[datetime="2026-06-09T08:40:00.000Z"]');
    expect(timelineTime).not.toBeNull();
    expect(timelineTime?.className).toMatch(/text-right/);
    // Granular CI check failure surfaces by name + annotation.
    expect(screen.getByRole("link", { name: /ESLint/i })).toBeVisible();
    expect(screen.getByText(/'reporter' is defined but never used\./)).toBeVisible();
    // Review thread comment renders inline with resolution status.
    expect(screen.getByText("Should this guard against null PR?")).toBeVisible();
    expect(screen.getByText(/Needs action/i)).toBeVisible();
  });
});
