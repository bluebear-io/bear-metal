import type { Ticket, TicketContext } from "../shared/index.js";

export function makeTicket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Ticket ${id}`,
    description: null,
    url: `https://linear.app/${id}`,
    branchName: `feature/${id.toLowerCase()}`,
    status: { name: "Todo", type: "unstarted" },
    priority: 0,
    labels: ["bear-metal"],
    teamKey: "DEN",
    assignee: { id: "creator" },
    // Default delegate to the agent the scheduler tests run as ("user-1"), so a refreshed
    // ticket reads as "mine"; park/resume tests override with a different id.
    delegate: { id: "user-1" },
    ...overrides,
  };
}

export function makeContext(id: string): TicketContext {
  return { ticket: makeTicket(id), prs: [] };
}
