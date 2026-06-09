import { useQuery } from "@tanstack/react-query";

import { fetchTicketDetail, fetchTickets, fetchWorkers, fetchWorkerTimeline } from "./client.js";
import type { BmStatus } from "./types.js";

export const useTickets = (status?: BmStatus) =>
  useQuery({ queryKey: ["tickets", status ?? "all"], queryFn: () => fetchTickets(status) });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

export const useWorkerTimeline = (hours: number) =>
  useQuery({ queryKey: ["workerTimeline", hours], queryFn: () => fetchWorkerTimeline(hours) });
