import { useState } from "react";
import { useWorkers, useWorkersTimeline } from "../api/queries.js";
import type { WorkerListItem } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { WorkerTimelineGantt } from "../components/WorkerTimelineGantt.js";
import { formatDateTime, formatDurationMs } from "../lib/format.js";

const TIMELINE_RANGE_OPTIONS = [24, 48, 72] as const;
type TimelineRange = (typeof TIMELINE_RANGE_OPTIONS)[number];

const dash = "—";

const workerHealth = (worker: WorkerListItem): "dead" | "timed_out" | "heartbeat_stale" | "healthy" => {
  if (worker.isDead) {
    return "dead";
  }

  if (worker.isTimedOut) {
    return "timed_out";
  }

  if (worker.isHeartbeatStale) {
    return "heartbeat_stale";
  }

  return "healthy";
};

export default function WorkersPage() {
  const workersQuery = useWorkers();
  const workers = workersQuery.data ?? [];
  const [timelineHours, setTimelineHours] = useState<TimelineRange>(24);
  const timelineQuery = useWorkersTimeline(timelineHours);

  const refreshAll = () => {
    void workersQuery.refetch();
    void timelineQuery.refetch();
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Workers">
        <RefreshButton busy={workersQuery.isFetching || timelineQuery.isFetching} onClick={refreshAll} />
      </PageHeader>

      <section className="flex flex-col gap-3" aria-label="Worker state timeline">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Range:</span>
          {TIMELINE_RANGE_OPTIONS.map((hours) => {
            const active = hours === timelineHours;
            return (
              <button
                key={hours}
                type="button"
                onClick={() => setTimelineHours(hours)}
                className={`rounded-md border px-2 py-1 text-xs ${active ? "border-primary text-primary" : "border-border-default text-text-secondary hover:text-text-primary"}`}
                aria-pressed={active}
              >
                {hours}h
              </button>
            );
          })}
        </div>
        <QueryBoundary
          isLoading={timelineQuery.isLoading}
          error={timelineQuery.error}
          isEmpty={(timelineQuery.data?.workers.length ?? 0) === 0}
          emptyLabel="No worker state transitions recorded for this window."
        >
          {timelineQuery.data ? <WorkerTimelineGantt data={timelineQuery.data} /> : null}
        </QueryBoundary>
      </section>

      <QueryBoundary
        isLoading={workersQuery.isLoading}
        error={workersQuery.error}
        isEmpty={workers.length === 0}
        emptyLabel="No workers."
      >
        <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
          <table className="min-w-full divide-y divide-border-default text-left text-sm">
            <thead className="bg-bg-muted text-xs font-medium uppercase text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">
                  Worker
                </th>
                <th scope="col" className="px-4 py-2">
                  Status
                </th>
                <th scope="col" className="px-4 py-2">
                  Ticket
                </th>
                <th scope="col" className="px-4 py-2">
                  Run
                </th>
                <th scope="col" className="px-4 py-2">
                  Runtime
                </th>
                <th scope="col" className="px-4 py-2">
                  Health
                </th>
                <th scope="col" className="px-4 py-2">
                  Heartbeat age
                </th>
                <th scope="col" className="px-4 py-2">
                  Last heartbeat
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {workers.map((worker) => (
                <tr key={worker.id} className="align-top">
                  <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-text-primary">
                    {worker.name}
                  </th>
                  <td className="px-4 py-3">
                    <StatusBadge status={worker.status} />
                  </td>
                  <td className="min-w-64 px-4 py-3">
                    {worker.currentTicketIdentifier === null ? (
                      <span className="text-text-muted">{dash}</span>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-text-primary">{worker.currentTicketIdentifier}</span>
                        <span className="text-text-secondary">{worker.currentTicketTitle ?? dash}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {worker.currentRun === null ? (
                      <span className="text-text-muted">{dash}</span>
                    ) : (
                      <StatusBadge status={worker.currentRun.status} />
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                    {formatDurationMs(worker.currentRun?.runtimeMs ?? null)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={workerHealth(worker)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                    {formatDurationMs(worker.heartbeatAgeMs)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                    {formatDateTime(worker.lastHeartbeatAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryBoundary>
    </main>
  );
}
