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
    labels: ["bear-metal"],
    ...overrides,
  };
}

export function makeContext(id: string): TicketContext {
  return { ticket: makeTicket(id), pr: null };
}
