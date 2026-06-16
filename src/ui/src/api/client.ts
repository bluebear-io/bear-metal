import type {
  BmStatus,
  Config,
  ModelComparisonRow,
  PeriodSummary,
  TicketDetail,
  TicketFilterOptions,
  TicketListQuery,
  TicketListResponse,
  ToolCallDetail,
  WorkerListItem,
} from "./types.js";

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

function appendList(params: URLSearchParams, key: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  // Server accepts both repeated keys and a comma-separated single key. Repeated keys keep
  // the URL readable when labels contain commas.
  for (const v of values) {
    params.append(key, v);
  }
}

export function buildTicketsPath(query: TicketListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  appendList(params, "statuses", query.bmStatuses);
  appendList(params, "workerId", query.workerIds);
  appendList(params, "label", query.labels);
  appendList(params, "stopReason", query.stopReasons);
  if (query.createdFrom) params.set("createdFrom", query.createdFrom);
  if (query.createdTo) params.set("createdTo", query.createdTo);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  return qs.length === 0 ? "/api/tickets" : `/api/tickets?${qs}`;
}

/**
 * Fetch the ticket archive. Pass a {@link BmStatus} to use the legacy single-status path
 * (matches the original API), or a {@link TicketListQuery} to drive the new filter bar.
 */
export async function fetchTickets(query?: BmStatus | TicketListQuery): Promise<TicketListResponse> {
  let path: string;
  if (typeof query === "string") {
    path = `/api/tickets?status=${encodeURIComponent(query)}`;
  } else {
    path = buildTicketsPath(query ?? {});
  }
  return getJson<TicketListResponse>(path);
}

export async function fetchTicketFilters(): Promise<TicketFilterOptions> {
  return getJson<TicketFilterOptions>("/api/tickets/filters");
}

export async function fetchTicketDetail(id: string): Promise<TicketDetail> {
  return getJson<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`);
}

export async function fetchToolCallDetail(runId: string, sequence: number): Promise<ToolCallDetail> {
  return getJson<ToolCallDetail>(
    `/api/tool-calls/${encodeURIComponent(runId)}/${encodeURIComponent(String(sequence))}`,
  );
}

export async function fetchEventPayload(eventId: string): Promise<string | null> {
  const body = await getJson<{ payloadJson: string | null }>(`/api/events/${encodeURIComponent(eventId)}/payload`);
  return body.payloadJson;
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

export async function fetchConfig(): Promise<Config> {
  return getJson<Config>("/api/config");
}
