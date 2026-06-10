import type { BmStatus, ModelComparisonRow, PeriodSummary, TicketDetail, TicketListItem, WorkerListItem } from "./types.js";

export interface SummaryRange {
  from: Date;
  to: Date;
}

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

export async function fetchModelComparison(): Promise<ModelComparisonRow[]> {
  const body = await getJson<{ models: ModelComparisonRow[] }>("/api/models/comparison");

  return body.models;
}

export async function fetchSummary(range: SummaryRange): Promise<PeriodSummary> {
  const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
  return getJson<PeriodSummary>(`/api/summary?${params.toString()}`);
}
