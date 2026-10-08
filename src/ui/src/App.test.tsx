import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App.js";
import { fetchAgentRunDetail } from "./api/client.js";
import { renderWithProviders } from "./test/utils.js";

vi.mock("./api/client.js", () => ({
  fetchTasks: vi.fn().mockResolvedValue({ tasks: [{ id: "coord-1", type: "coordinator", status: "succeeded", runStatus: "succeeded", ticketId: null, identifier: null, title: "Slack thread coordination", ticketUrl: null, attemptCount: 1, workerId: null, assigneeName: null, updatedAt: "2026-10-01T10:01:00.000Z", createdAt: "2026-10-01T10:00:00.000Z", pullRequests: [] }], total: 1, page: 1, pageSize: 20 }),
  fetchAgentRunDetail: vi.fn().mockResolvedValue({ run: { id: "coord-1", type: "coordinator", status: "succeeded", ticketId: null, ticketIdentifier: null, ticketTitle: null, ticketUrl: null, slackWorkspaceId: "T1", slackChannelId: "C1", slackThreadTs: "100.0", slackSourceTs: "101.0", request: "coordinate", resultJson: null, error: null, provider: "anthropic", modelName: "claude", promptTokens: null, completionTokens: null, costUsd: null, attemptNumber: 1, workerId: null, stopReason: "completed", inputJson: null, contextJson: null, slackState: null, startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:01:00.000Z", createdAt: "2026-10-01T10:00:00.000Z" }, trace: [{ id: "trace-1", runId: "coord-1", kind: "assistant_text", contentJson: JSON.stringify({ text: "The request was ignored." }), createdAt: "2026-10-01T10:00:30.000Z" }] }),
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

  it("renders nav and the tasks page at root", async () => {
    renderWithProviders(<App />, "/");

    expect(screen.getByTestId("app-root")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workers" })).toBeInTheDocument();
    expect(await screen.findByText("Slack thread coordination")).toBeInTheDocument();
  });

  it("redirects legacy tickets links to tasks", async () => {
    renderWithProviders(<App />, "/tickets");

    expect(await screen.findByText("Slack thread coordination")).toBeInTheDocument();
  });

  it("shows coordinator runs and assistant output", async () => {
    renderWithProviders(<App />, "/");
    await userEvent.click(await screen.findByText("Slack thread coordination"));
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Input / output" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Event log" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Assistant output"));
    expect(await screen.findAllByText("The request was ignored.")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Open thread" })).toHaveAttribute("href", "https://app.slack.com/archives/C1/p1000");
  });

  it("shows research in the same summary, runs, and event log layout", async () => {
    vi.mocked(fetchAgentRunDetail).mockResolvedValueOnce({
      run: { id: "research-1", type: "research", status: "succeeded", slackState: "coordinated",
        slackQuote: "What is 2 + 2?", slackReplyTs: "101.0", attemptNumber: 1, workerId: null,
        stopReason: "completed", promptTokens: 10, completionTokens: 5, costUsd: 0.25, contextJson: null, inputJson: null,
        ticketId: null, ticketIdentifier: null, ticketTitle: null, ticketUrl: null, slackWorkspaceId: "T1",
        slackChannelId: "C1", slackThreadTs: "100.0", slackSourceTs: "100.0",
        request: "What is 2 + 2?", resultJson: '{"answer":"4"}', error: null, provider: "anthropic",
        modelName: "claude", startedAt: "2026-10-01T10:00:00.000Z", endedAt: "2026-10-01T10:01:00.000Z",
        createdAt: "2026-10-01T10:00:00.000Z" },
      trace: [{ id: "tool-1", runId: "research-1", kind: "tool_call", contentJson: '{"toolName":"answer_research","resultStatus":"ok"}',
        createdAt: "2026-10-01T10:00:30.000Z" }],
    });
    renderWithProviders(<App />, "/tasks/research/research-1");
    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Input / output" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Summary" }).compareDocumentPosition(screen.getByRole("heading", { name: "Input / output" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Event log" })).toBeInTheDocument();
    expect(screen.getByText("coordinated")).toBeInTheDocument();
    expect(screen.getByText("answer_research")).toBeInTheDocument();
    expect(screen.getAllByText("$0.250")).toHaveLength(2);
  });

  it("shows processed coordinator messages and its persisted output below the summary", async () => {
    const detail = await fetchAgentRunDetail("coord-1");
    vi.mocked(fetchAgentRunDetail).mockResolvedValueOnce({ ...detail, run: {
      ...detail.run,
      inputJson: JSON.stringify({ messages: [{ text: "<@UBOT> how are you?" }] }),
      resultJson: JSON.stringify({ replies: ["I'm all good, my friend"], decision: "Requests processed." }),
    }, trace: [] });
    renderWithProviders(<App />, "/tasks/coordinator/coord-1");
    const heading = await screen.findByRole("heading", { name: "Input / output" });
    const section = heading.closest("section");
    if (!section) throw new Error("Input/output section missing");
    expect(within(section).getByText("<@UBOT> how are you?")).toBeVisible();
    expect(within(section).getByText("I'm all good, my friend")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Summary" }).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["inputJson", "{broken input", "input"],
    ["resultJson", "{broken output", "output"],
  ] as const)("keeps task details visible when %s is malformed", async (field, raw, label) => {
    const detail = await fetchAgentRunDetail("coord-1");
    vi.mocked(fetchAgentRunDetail).mockResolvedValueOnce({ ...detail, run: { ...detail.run, [field]: raw } });
    renderWithProviders(<App />, "/tasks/coordinator/coord-1");
    const heading = await screen.findByRole("heading", { name: "Input / output" });
    const section = heading.closest("section");
    if (!section) throw new Error("Input/output section missing");
    expect(within(section).getByRole("alert")).toHaveTextContent(`Unable to read task ${label}`);
    expect(within(section).getByText(raw)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Event log" })).toBeVisible();
  });

  it("toggles the document theme class", async () => {
    renderWithProviders(<App />, "/");

    // Open the settings dropdown
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    // Select "Dark" theme
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
  });
});
