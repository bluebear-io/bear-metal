import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AnalyticsSummary } from "../api/types.js";
import { renderWithProviders } from "../test/utils.js";
import AnalyticsPage from "./AnalyticsPage.js";

const analytics: AnalyticsSummary = {
  generatedAt: "2026-06-09T09:30:00.000Z",
  outcomes: { total: 4, completed: 1, abandoned: 1, inFlight: 2, successRate: 0.5, abandonmentRate: 0.5 },
  attemptsDistribution: [
    { attempts: 1, count: 1 },
    { attempts: 5, count: 1 },
  ],
  mttr: {
    sampleSize: 1,
    meanMs: 50 * 60 * 1000,
    medianMs: 50 * 60 * 1000,
    p90Ms: 50 * 60 * 1000,
  },
  throughput: [
    { date: "2026-06-08", created: 1, completed: 0 },
    { date: "2026-06-09", created: 3, completed: 1 },
  ],
};

vi.mock("../api/client.js", () => ({
  fetchAnalytics: vi.fn().mockResolvedValue(analytics),
}));

describe("AnalyticsPage", () => {
  it("renders KPI cards and charts", async () => {
    renderWithProviders(<AnalyticsPage />, "/analytics");

    expect(await screen.findByText("Success rate")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText("Abandonment rate")).toBeInTheDocument();
    expect(screen.getByText("Mean time to resolution")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Ticket outcome distribution/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Attempts per ticket/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Ticket volume throughput/i })).toBeInTheDocument();
  });
});
