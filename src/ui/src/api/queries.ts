import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  fetchAgentRunDetail,
  fetchTasks,
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

export const useAgentRunDetail = (id: string) =>
  useQuery({ queryKey: ["agent-run", id], queryFn: () => fetchAgentRunDetail(id), refetchInterval: 5000 });
import type { TaskListQuery, TicketListQuery } from "./types.js";

export const useTasks = (query: TaskListQuery = {}) => useInfiniteQuery({
  queryKey: ["tasks", query],
  initialPageParam: query.page ?? 1,
  queryFn: ({ pageParam }) => fetchTasks({ ...query, page: Number(pageParam) }),
  getNextPageParam: (lastPage) => lastPage.page * lastPage.pageSize < lastPage.total ? lastPage.page + 1 : undefined,
  refetchInterval: 5000,
});

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

export const useTaskFilterOptions = () => useQuery({
  queryKey: ["tickets", "filters"],
  queryFn: () => fetchTicketFilters(),
  select: (filters) => ({ ...filters, statuses: [...filters.bmStatuses, "queued", "running", "awaiting_coordination",
    "approved", "posting", "coordinated", "canceled", "succeeded", "dispatched", "timed_out", "crashed"] }),
});

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
