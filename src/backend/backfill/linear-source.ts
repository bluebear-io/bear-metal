import type { Ticket } from "../../shared/index.js";

/**
 * The slice of `LinearIntegration` the backfill loader needs. Stating it as an interface lets tests
 * inject a fake without instantiating the SDK.
 */
export interface LinearSource {
  findAllDelegatedTickets(agentId: string): Promise<Ticket[]>;
}

export interface LoadDelegatedTicketsOptions {
  agentId: string;
  /** Hard cap on tickets returned. Applied after the Linear fetch (callers truncate any extras). */
  limit?: number;
}

export async function loadDelegatedTickets(
  source: LinearSource,
  options: LoadDelegatedTicketsOptions,
): Promise<Ticket[]> {
  const tickets = await source.findAllDelegatedTickets(options.agentId);
  if (options.limit !== undefined && tickets.length > options.limit) {
    return tickets.slice(0, options.limit);
  }
  return tickets;
}
