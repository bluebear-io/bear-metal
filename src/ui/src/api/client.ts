import type { BmStatus, BudgetStatus, CostPeriod, CostSummary, TicketCost, TicketDetail, TicketListItem, WorkerListItem } from "./types.js";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);

  if (!res.ok) {
    throw new Error(`Request to ${path} failed with HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchTickets(status?: BmStatus): Promise<TicketListItem[]> {
  const path = status ? `/api/tickets?status=${encodeURIComponent(status)}` : "/api/tickets";
  const body = await getJson<{ tickets: TicketListItem[] }>(path);

  return body.tickets;
}

export async function fetchTicketDetail(id: string): Promise<TicketDetail> {
  return getJson<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`);
}

export async function fetchWorkers(): Promise<WorkerListItem[]> {
  const body = await getJson<{ workers: WorkerListItem[] }>("/api/workers");

  return body.workers;
}

export async function fetchTicketCosts(): Promise<TicketCost[]> {
  const body = await getJson<{ tickets: TicketCost[] }>("/api/costs/tickets");
  return body.tickets;
}

export async function fetchCostSummary(period: CostPeriod): Promise<CostSummary> {
  return getJson<CostSummary>(`/api/costs/summary?period=${encodeURIComponent(period)}`);
}

export async function fetchBudgetStatus(): Promise<BudgetStatus> {
  return getJson<BudgetStatus>("/api/costs/budget");
}
