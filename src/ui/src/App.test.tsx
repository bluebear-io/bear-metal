import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App.js";
import { renderWithProviders } from "./test/utils.js";

vi.mock("./api/client.js", () => ({
  fetchTicketDetail: vi.fn(),
  fetchTickets: vi.fn().mockResolvedValue([]),
  fetchWorkers: vi.fn().mockResolvedValue([]),
  fetchAnalytics: vi.fn().mockResolvedValue({
    generatedAt: "2026-06-09T09:00:00.000Z",
    outcomes: { total: 0, completed: 0, abandoned: 0, inFlight: 0, successRate: 0, abandonmentRate: 0 },
    attemptsDistribution: [],
    mttr: { sampleSize: 0, meanMs: null, medianMs: null, p90Ms: null },
    throughput: [],
  }),
}));

describe("App", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("renders nav and the tickets page at root", async () => {
    renderWithProviders(<App />, "/");

    expect(screen.getByTestId("app-root")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tickets" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workers" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Analytics" })).toBeInTheDocument();
    expect(await screen.findByText("No tickets yet.")).toBeInTheDocument();
  });

  it("renders the tickets page at /tickets for detail back links", async () => {
    renderWithProviders(<App />, "/tickets");

    expect(await screen.findByText("No tickets yet.")).toBeInTheDocument();
  });

  it("toggles the document theme class", async () => {
    renderWithProviders(<App />, "/");

    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    expect(document.documentElement).toHaveClass("dark");
  });
});
