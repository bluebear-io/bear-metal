import { useQuery } from "@tanstack/react-query";

import { fetchRunLogs, fetchTicketDetail, fetchTickets, fetchWorkers } from "./client.js";
import type { BmStatus } from "./types.js";

export const useTickets = (status?: BmStatus) =>
  useQuery({ queryKey: ["tickets", status ?? "all"], queryFn: () => fetchTickets(status) });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });

/** Polls every 2s while enabled so an in-flight run's logs stream into the UI. */
export const useRunLogs = (runId: string, enabled: boolean) =>
  useQuery({
    queryKey: ["run-logs", runId],
    queryFn: () => fetchRunLogs(runId),
    enabled,
    refetchInterval: enabled ? 2_000 : false,
  });
