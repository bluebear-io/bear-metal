import type { CSSProperties } from "react";
import type { WorkerStatus, WorkerTimeline, WorkersTimelineResponse } from "../api/types.js";

// Re-uses the same palette idea as StatusBadge so colors stay consistent across
// the page (idle/busy/stopped/dead).
const colorByStatus: Record<WorkerStatus, string> = {
  busy: "var(--color-primary)",
  idle: "var(--color-text-muted)",
  stopped: "var(--color-text-muted)",
  dead: "var(--color-status-red)",
};

const HOUR_MS = 60 * 60 * 1000;

const formatHourTick = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

const formatTooltip = (status: WorkerStatus, startMs: number, endMs: number): string => {
  const durationMin = Math.round((endMs - startMs) / 60_000);
  const start = new Date(startMs).toLocaleString();
  const end = new Date(endMs).toLocaleString();
  return `${status} • ${durationMin}m\n${start} → ${end}`;
};

export interface WorkerTimelineGanttProps {
  data: WorkersTimelineResponse;
  /** Hour spacing between vertical gridline ticks. */
  tickEveryHours?: number;
}

export function WorkerTimelineGantt({ data, tickEveryHours = 6 }: WorkerTimelineGanttProps) {
  const windowStartMs = new Date(data.windowStart).getTime();
  const windowEndMs = new Date(data.windowEnd).getTime();
  const totalMs = windowEndMs - windowStartMs;

  if (totalMs <= 0 || data.workers.length === 0) {
    return (
      <div className="rounded-md border border-border-default bg-bg-card px-4 py-6 text-sm text-text-muted">
        No worker timeline data for the selected window.
      </div>
    );
  }

  const ticks = buildTicks(windowStartMs, windowEndMs, tickEveryHours);

  return (
    <div className="rounded-md border border-border-default bg-bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Worker state timeline ({data.hours}h)
        </h3>
        <Legend />
      </div>

      <div className="flex flex-col gap-1.5">
        {data.workers.map((worker) => (
          <Row key={worker.workerId} worker={worker} windowStartMs={windowStartMs} totalMs={totalMs} />
        ))}
      </div>

      <div className="mt-2 grid" style={{ gridTemplateColumns: "8rem 1fr" }}>
        <div />
        <div className="relative h-5 border-t border-border-default">
          {ticks.map((tick) => {
            const left = ((tick.ms - windowStartMs) / totalMs) * 100;
            return (
              <div
                key={tick.ms}
                className="absolute top-0 -translate-x-1/2 text-[10px] text-text-muted"
                style={{ left: `${left}%` }}
              >
                {tick.label}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Row({
  worker,
  windowStartMs,
  totalMs,
}: {
  worker: WorkerTimeline;
  windowStartMs: number;
  totalMs: number;
}) {
  return (
    <div className="grid items-center" style={{ gridTemplateColumns: "8rem 1fr" }}>
      <div className="truncate pr-3 text-xs font-medium text-text-primary" title={worker.workerName}>
        {worker.workerName}
      </div>
      <div className="relative h-6 rounded bg-bg-muted">
        {worker.segments.map((segment, idx) => {
          const leftPct = ((segment.startMs - windowStartMs) / totalMs) * 100;
          const widthPct = Math.max(((segment.endMs - segment.startMs) / totalMs) * 100, 0.2);
          const style: CSSProperties = {
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            backgroundColor: colorByStatus[segment.status],
          };
          return (
            <div
              key={`${worker.workerId}-${idx}`}
              className="absolute top-0 h-full rounded-sm opacity-90"
              style={style}
              title={formatTooltip(segment.status, segment.startMs, segment.endMs)}
              data-testid={`gantt-segment-${worker.workerId}-${segment.status}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  const items: WorkerStatus[] = ["busy", "idle", "stopped", "dead"];
  return (
    <div className="flex items-center gap-3 text-xs text-text-secondary">
      {items.map((status) => (
        <div key={status} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: colorByStatus[status] }}
          />
          <span>{status}</span>
        </div>
      ))}
    </div>
  );
}

function buildTicks(startMs: number, endMs: number, everyHours: number): { ms: number; label: string }[] {
  const ticks: { ms: number; label: string }[] = [];
  const step = everyHours * HOUR_MS;
  // Align first tick to the next hour boundary inside the window so labels look clean.
  const first = Math.ceil(startMs / HOUR_MS) * HOUR_MS;
  for (let ms = first; ms <= endMs; ms += step) {
    ticks.push({ ms, label: formatHourTick(new Date(ms)) });
  }
  return ticks;
}
