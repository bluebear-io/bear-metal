import { useQuery } from "@tanstack/react-query";

import {
  fetchConfig,
  fetchModelComparison,
  fetchSummary,
  fetchTicketDetail,
  fetchTicketFilters,
  fetchTickets,
  fetchWorkers,
  fetchWorkerTimeline,
  type SummaryRange,
  type WorkerTimelineRange,
} from "./client.js";
import type { BmStatus, TicketListQuery } from "./types.js";

export const useTickets = (query?: BmStatus | TicketListQuery) => {
  // Serialize the query to make the cache key deterministic; useQuery requires a stable key.
  const key = typeof query === "string" ? { status: query } : query ?? {};
  return useQuery({
    queryKey: ["tickets", key],
    queryFn: () => fetchTickets(query),
  });
};

export const useTicketFilterOptions = () =>
  useQuery({ queryKey: ["tickets", "filters"], queryFn: () => fetchTicketFilters() });

export const useTicketDetail = (id: string) =>
  useQuery({
    queryKey: ["ticket", id],
    queryFn: () => fetchTicketDetail(id),
    refetchInterval: 5000,
  });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

export const useWorkerTimeline = (range: WorkerTimelineRange) =>
  useQuery({
    queryKey: ["workers", "timeline", range.from.toISOString(), range.to.toISOString()],
    queryFn: () => fetchWorkerTimeline(range),
  });

export const useModelComparison = () =>
  useQuery({ queryKey: ["models", "comparison"], queryFn: () => fetchModelComparison() });

export const useSummary = (range: SummaryRange) =>
  useQuery({
    queryKey: ["summary", range.from.toISOString(), range.to.toISOString()],
    queryFn: () => fetchSummary(range),
  });

export const useConfig = () =>
  useQuery({ queryKey: ["config"], queryFn: fetchConfig, staleTime: Infinity });
