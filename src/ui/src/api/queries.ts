import { useQuery } from "@tanstack/react-query";

import { fetchTicketDetail, fetchTicketFilterOptions, fetchTickets, fetchWorkers } from "./client.js";
import type { TicketFilters } from "./types.js";

export const useTickets = (filters: TicketFilters = {}) =>
  useQuery({
    queryKey: ["tickets", filters],
    queryFn: () => fetchTickets(filters),
  });

export const useTicketFilterOptions = () =>
  useQuery({ queryKey: ["tickets", "filters"], queryFn: () => fetchTicketFilterOptions() });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });
