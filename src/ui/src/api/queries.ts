import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  fetchConfig,
  fetchModelComparison,
  fetchSummary,
  fetchEventPayload,
  fetchTicketDetail,
  fetchTicketFilters,
  fetchTickets,
  fetchToolCallDetail,
  fetchWorkers,
  type SummaryRange,
} from "./client.js";
import type { TicketListQuery } from "./types.js";

export const useTickets = (query: TicketListQuery = {}) => {
  return useInfiniteQuery({
    queryKey: ["tickets", query],
    initialPageParam: query.page ?? 1,
    queryFn: ({ pageParam }) => fetchTickets({ ...query, page: Number(pageParam) }),
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.page * lastPage.pageSize;
      return loaded < lastPage.total ? lastPage.page + 1 : undefined;
    },
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

export const useToolCallDetail = (runId: string, sequence: number, enabled: boolean) =>
  useQuery({
    queryKey: ["toolcall", runId, sequence],
    queryFn: () => fetchToolCallDetail(runId, sequence),
    enabled,
    staleTime: Infinity,
  });

export const useEventPayload = (eventId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["event-payload", eventId],
    queryFn: () => fetchEventPayload(eventId),
    enabled,
    staleTime: Infinity,
  });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

export const useModelComparison = () =>
  useQuery({ queryKey: ["models", "comparison"], queryFn: () => fetchModelComparison() });

export const useSummary = (range: SummaryRange) =>
  useQuery({
    queryKey: ["summary", range.from.toISOString(), range.to.toISOString()],
    queryFn: () => fetchSummary(range),
  });

export const useConfig = () =>
  useQuery({ queryKey: ["config"], queryFn: fetchConfig, staleTime: Infinity });
