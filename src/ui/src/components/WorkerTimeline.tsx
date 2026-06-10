import type { CSSProperties } from "react";

import type { WorkerStatus, WorkerTimelineResponse } from "../api/types.js";

const STATUS_COLOR: Record<WorkerStatus, string> = {
  // Mirrors StatusBadge tones so the Gantt and the table speak the same visual language.
  busy: "var(--color-primary)",
  idle: "var(--color-text-muted)",
  stopped: "var(--color-text-muted)",
  dead: "var(--color-status-red)",
};

const STATUS_LABEL: Record<WorkerStatus, string> = {
  busy: "Busy",
  idle: "Idle",
  stopped: "Stopped",
  dead: "Dead",
};

const HOUR_MS = 60 * 60 * 1000;

const formatHourTick = (ms: number): string => {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatRange = (startMs: number, endMs: number): string => {
  const fmt = (ms: number) => new Date(ms).toLocaleString();
  return `${fmt(startMs)} \u2192 ${fmt(endMs)}`;
};

/**
 * Tick step heuristic: pick the largest of {1h, 2h, 3h, 6h, 12h} that still produces at most
 * ~12 labels across the window. Keeps the axis readable for 24h, 48h, and 72h ranges without
 * hard-coding per-range styling.
 */
const computeTickHours = (totalHours: number): number => {
  for (const step of [1, 2, 3, 6, 12]) {
    if (totalHours / step <= 12) return step;
  }
  return 12;
};

export interface WorkerTimelineProps {
  data: WorkerTimelineResponse;
  hours: number;
}

export const WorkerTimeline = ({ data, hours }: WorkerTimelineProps) => {
  const { sinceMs, untilMs, workers } = data;
  const totalMs = Math.max(1, untilMs - sinceMs);
  const tickHours = computeTickHours(hours);
  const ticks: number[] = [];
  // Snap the first tick to a whole hour boundary inside the window so the labels read cleanly
  // (e.g. 14:00, 16:00, 18:00 rather than 14:23, 16:23, ...).
  const firstTickMs = Math.ceil(sinceMs / (tickHours * HOUR_MS)) * tickHours * HOUR_MS;
  for (let ms = firstTickMs; ms <= untilMs; ms += tickHours * HOUR_MS) {
    ticks.push(ms);
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Worker utilization (last {hours}h)</h2>
        <ul className="flex flex-wrap gap-3 text-xs text-text-secondary">
          {(Object.keys(STATUS_LABEL) as WorkerStatus[]).map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: STATUS_COLOR[s] }}
              />
              {STATUS_LABEL[s]}
            </li>
          ))}
        </ul>
      </header>

      {workers.length === 0 ? (
        <p className="text-sm text-text-muted">No workers.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {workers.map((w) => (
            <div key={w.workerId} className="grid grid-cols-[8rem_1fr] items-center gap-3">
              <div className="truncate text-sm font-medium text-text-primary" title={w.name}>
                {w.name}
              </div>
              <div className="relative h-6 overflow-hidden rounded-sm bg-bg-muted" role="img" aria-label={`Status timeline for ${w.name}`}>
                {w.intervals.map((iv, i) => {
                  const leftPct = ((iv.startMs - sinceMs) / totalMs) * 100;
                  const widthPct = ((iv.endMs - iv.startMs) / totalMs) * 100;
                  const style: CSSProperties = {
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    backgroundColor: STATUS_COLOR[iv.status],
                  };
                  return (
                    <div
                      key={`${w.workerId}-${i}`}
                      className="absolute top-0 h-full"
                      style={style}
                      title={`${STATUS_LABEL[iv.status]} \u2014 ${formatRange(iv.startMs, iv.endMs)}`}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          <div className="grid grid-cols-[8rem_1fr] gap-3 pt-2">
            <div />
            <div className="relative h-4 text-[10px] text-text-muted">
              {ticks.map((ms) => {
                const leftPct = ((ms - sinceMs) / totalMs) * 100;
                return (
                  <div
                    key={ms}
                    className="absolute top-0 -translate-x-1/2"
                    style={{ left: `${leftPct}%` }}
                  >
                    {formatHourTick(ms)}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
