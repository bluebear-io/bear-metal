import type {
  TicketDetail,
  TicketFilterOptions,
  TicketFilters,
  TicketsResponse,
  WorkerListItem,
} from "./types.js";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);

  if (!res.ok) {
    throw new Error(`Request to ${path} failed with HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

function appendArray(params: URLSearchParams, key: string, values?: readonly string[]): void {
  if (!values) return;
  for (const v of values) {
    if (v !== "") params.append(key, v);
  }
}

export function buildTicketsQuery(filters: TicketFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.search && filters.search.trim() !== "") params.set("search", filters.search.trim());
  appendArray(params, "bmStatus", filters.bmStatuses);
  appendArray(params, "workerId", filters.workerIds);
  appendArray(params, "label", filters.labels);
  appendArray(params, "stopReason", filters.stopReasons);
  if (filters.errorSignature && filters.errorSignature.trim() !== "") {
    params.set("errorSignature", filters.errorSignature.trim());
  }
  if (filters.createdAfter) params.set("createdAfter", filters.createdAfter);
  if (filters.createdBefore) params.set("createdBefore", filters.createdBefore);
  if (filters.updatedAfter) params.set("updatedAfter", filters.updatedAfter);
  if (filters.updatedBefore) params.set("updatedBefore", filters.updatedBefore);
  if (filters.page !== undefined) params.set("page", String(filters.page));
  if (filters.pageSize !== undefined) params.set("pageSize", String(filters.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchTickets(filters: TicketFilters = {}): Promise<TicketsResponse> {
  return getJson<TicketsResponse>(`/api/tickets${buildTicketsQuery(filters)}`);
}

export async function fetchTicketFilterOptions(): Promise<TicketFilterOptions> {
  return getJson<TicketFilterOptions>("/api/tickets/filters");
}

export async function fetchTicketDetail(id: string): Promise<TicketDetail> {
  return getJson<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`);
}

export async function fetchWorkers(): Promise<WorkerListItem[]> {
  const body = await getJson<{ workers: WorkerListItem[] }>("/api/workers");

  return body.workers;
}
