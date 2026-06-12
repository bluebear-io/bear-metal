import { useQuery } from "@tanstack/react-query";

import {
  fetchModelComparison, fetchSummary, fetchTicketDetail, fetchTickets, fetchWorkers,
  fetchWorkerTimeline,
  type SummaryRange, type WorkerTimelineRange,
} from "./client.js";
import type { BmStatus } from "./types.js";

export const useTickets = (status?: BmStatus) =>
  useQuery({ queryKey: ["tickets", status ?? "all"], queryFn: () => fetchTickets(status) });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

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
