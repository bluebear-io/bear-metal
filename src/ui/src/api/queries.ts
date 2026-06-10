import { useQuery } from "@tanstack/react-query";

import {
  fetchModelComparison,
  fetchTicketDetail,
  fetchTicketFilters,
  fetchTickets,
  fetchWorkers,
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
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

export const useModelComparison = () =>
  useQuery({ queryKey: ["models", "comparison"], queryFn: () => fetchModelComparison() });
