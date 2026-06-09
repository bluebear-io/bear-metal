import type { CSSProperties } from "react";

import type { WorkerStatus, WorkerTimelineEntry, WorkerTimelineResponse } from "../api/types.js";

const STATUS_COLOR: Record<WorkerStatus, string> = {
  busy: "var(--color-primary)",
  idle: "var(--color-text-muted)",
  stopped: "var(--color-text-muted)",
  dead: "var(--color-status-red)",
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  busy: "busy",
  idle: "idle",
  stopped: "stopped",
  dead: "dead",
};

const formatAxisTick = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);

/**
 * Compute evenly-spaced tick marks across the [start, end] window. Caps the count so the
 * axis stays legible regardless of `hours` (24h → ~6 ticks, 72h → ~8 ticks).
 */
const buildTicks = (start: Date, end: Date, hours: number): Date[] => {
  const tickCount = hours <= 24 ? 6 : 8;
  const step = (end.getTime() - start.getTime()) / tickCount;
  const ticks: Date[] = [];
  for (let i = 0; i <= tickCount; i++) {
    ticks.push(new Date(start.getTime() + step * i));
  }
  return ticks;
};

export interface WorkerTimelineChartProps {
  data: WorkerTimelineResponse;
}

export const WorkerTimelineChart = ({ data }: WorkerTimelineChartProps) => {
  const windowStart = new Date(data.windowStart).getTime();
  const windowEnd = new Date(data.windowEnd).getTime();
  const span = Math.max(1, windowEnd - windowStart);

  const ticks = buildTicks(new Date(windowStart), new Date(windowEnd), data.hours);

  const statuses: WorkerStatus[] = ["busy", "idle", "stopped", "dead"];

  return (
    <div className="rounded-md border border-border-default bg-bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-default px-4 py-2 text-xs text-text-secondary">
        <span className="font-medium text-text-primary">Worker timeline</span>
        <span>last {data.hours}h</span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {statuses.map((status) => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2.5 w-3 rounded-sm"
                style={{ backgroundColor: STATUS_COLOR[status] }}
              />
              {STATUS_LABEL[status]}
            </span>
          ))}
        </span>
      </div>

      <div className="px-4 py-3">
        {data.workers.length === 0 ? (
          <p className="text-sm text-text-muted">No workers.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.workers.map((worker) => (
              <WorkerRow key={worker.id} worker={worker} windowStart={windowStart} span={span} />
            ))}
            <div className="relative mt-2 h-5">
              {ticks.map((tick, i) => {
                const left = ((tick.getTime() - windowStart) / span) * 100;
                const style: CSSProperties = { left: `${left}%` };
                return (
                  <span
                    key={i}
                    style={style}
                    className="absolute -translate-x-1/2 text-[10px] text-text-muted"
                  >
                    {formatAxisTick(tick)}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

interface WorkerRowProps {
  worker: WorkerTimelineEntry;
  windowStart: number;
  span: number;
}

const WorkerRow = ({ worker, windowStart, span }: WorkerRowProps) => (
  <div className="flex items-center gap-3">
    <span className="w-28 shrink-0 truncate text-xs font-medium text-text-primary" title={worker.name}>
      {worker.name}
    </span>
    <div
      role="img"
      aria-label={`${worker.name} status timeline`}
      className="relative h-5 flex-1 overflow-hidden rounded-sm bg-bg-muted"
      data-testid={`worker-timeline-row-${worker.id}`}
    >
      {worker.segments.map((segment, i) => {
        const segStart = new Date(segment.startAt).getTime();
        const segEnd = new Date(segment.endAt).getTime();
        const left = ((segStart - windowStart) / span) * 100;
        const width = ((segEnd - segStart) / span) * 100;
        if (width <= 0) return null;
        const style: CSSProperties = {
          left: `${left}%`,
          width: `${width}%`,
          backgroundColor: STATUS_COLOR[segment.status],
        };
        const title = `${STATUS_LABEL[segment.status]} · ${new Date(segStart).toLocaleString()} → ${new Date(segEnd).toLocaleString()}`;
        return (
          <span
            key={i}
            style={style}
            title={title}
            data-status={segment.status}
            className="absolute inset-y-0 block"
          />
        );
      })}
    </div>
  </div>
);
