import { useQuery } from "@tanstack/react-query";

import { fetchBudgetStatus, fetchCostSummary, fetchTicketCosts, fetchTicketDetail, fetchTickets, fetchWorkers } from "./client.js";
import type { BmStatus, CostPeriod } from "./types.js";

export const useTickets = (status?: BmStatus) =>
  useQuery({ queryKey: ["tickets", status ?? "all"], queryFn: () => fetchTickets(status) });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

export const useTicketCosts = () =>
  useQuery({ queryKey: ["costs", "tickets"], queryFn: () => fetchTicketCosts() });

export const useCostSummary = (period: CostPeriod) =>
  useQuery({ queryKey: ["costs", "summary", period], queryFn: () => fetchCostSummary(period) });

export const useBudgetStatus = () =>
  useQuery({ queryKey: ["costs", "budget"], queryFn: () => fetchBudgetStatus() });
