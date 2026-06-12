import type { AnalyticsSummary, BmStatus, RepoBreakdown, TicketDetail, TicketListItem, WorkerListItem } from "./types.js";

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

export async function listRepos(): Promise<RepoBreakdown[]> {
  const body = await getJson<{ repos: RepoBreakdown[] }>("/api/repos");

  return body.repos;
}

export async function fetchAnalytics(): Promise<AnalyticsSummary> {
  return getJson<AnalyticsSummary>("/api/analytics");
}
