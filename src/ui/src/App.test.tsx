import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App.js";
import { renderWithProviders } from "./test/utils.js";

vi.mock("./api/client.js", () => ({
  fetchTicketDetail: vi.fn(),
  fetchTickets: vi.fn().mockResolvedValue({ tickets: [], total: 0, page: 1, pageSize: 50 }),
  fetchTicketFilters: vi.fn().mockResolvedValue({ bmStatuses: [], stopReasons: [], labels: [], workers: [] }),
  fetchWorkers: vi.fn().mockResolvedValue([]),
  fetchModelComparison: vi.fn().mockResolvedValue([]),
  fetchConfig: vi.fn().mockResolvedValue({ maxIterations: 5 }),
  buildTicketsPath: vi.fn().mockReturnValue("/api/tickets"),
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
    expect(await screen.findByText("No tickets yet.")).toBeInTheDocument();
  });

  it("renders the tickets page at /tickets for detail back links", async () => {
    renderWithProviders(<App />, "/tickets");

    expect(await screen.findByText("No tickets yet.")).toBeInTheDocument();
  });

  it("toggles the document theme class", async () => {
    renderWithProviders(<App />, "/");

    // Starts in "system" state; first click → "light"
    await userEvent.click(screen.getByRole("button", { name: "System theme" }));
    // Second click → "dark"
    await userEvent.click(screen.getByRole("button", { name: "Light theme" }));
    expect(document.documentElement).toHaveClass("dark");
  });
});
