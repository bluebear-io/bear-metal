import { useMemo } from "react";
import type { WorkerStatus, WorkerTimelineRow } from "../api/types.js";

const statusColor: Record<WorkerStatus, string> = {
  idle: "var(--color-text-muted)",
  busy: "var(--color-primary)",
  stopped: "var(--color-status-orange)",
  dead: "var(--color-status-red)",
};

const ALL_STATUSES: WorkerStatus[] = ["busy", "idle", "stopped", "dead"];

export interface WorkerTimelineChartProps {
  workers: WorkerTimelineRow[];
  windowFromIso: string;
  windowToIso: string;
}

interface TickLabel {
  leftPct: number;
  label: string;
}

/**
 * Compute up to ~8 tick labels evenly spaced across the window. Uses 1h steps for ≤24h windows,
 * 6h for ≤72h, and 12h for everything larger so labels never overlap.
 */
function buildTicks(fromMs: number, toMs: number): TickLabel[] {
  const span = toMs - fromMs;
  const hour = 60 * 60 * 1000;
  const stepHours = span <= 24 * hour ? 4 : span <= 72 * hour ? 12 : 24;
  const step = stepHours * hour;
  const ticks: TickLabel[] = [];
  // Snap to whole hours from the right edge so the rightmost label is "now".
  const lastTick = Math.floor(toMs / hour) * hour;
  for (let t = lastTick; t >= fromMs; t -= step) {
    const leftPct = ((t - fromMs) / span) * 100;
    const d = new Date(t);
    ticks.push({ leftPct, label: `${d.getHours().toString().padStart(2, "0")}:00` });
  }
  return ticks.reverse();
}

export function WorkerTimelineChart({ workers, windowFromIso, windowToIso }: WorkerTimelineChartProps) {
  const fromMs = new Date(windowFromIso).getTime();
  const toMs = new Date(windowToIso).getTime();
  const span = Math.max(1, toMs - fromMs);
  // Treat open spans as ending at the window's right edge — keeps the visualization stable
  // even if the server clock and the requested `to` drift slightly.
  const nowMs = toMs;
  const ticks = useMemo(() => buildTicks(fromMs, toMs), [fromMs, toMs]);

  if (workers.length === 0) {
    return <p className="text-sm text-text-muted">No worker timeline data.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
        {ALL_STATUSES.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: statusColor[s] }}
            />
            {s}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1.5">
        {workers.map((w) => (
          <div key={w.workerId} className="contents">
            <div className="truncate text-sm text-text-primary" title={w.workerName}>
              {w.workerName}
            </div>
            <div className="relative h-6 rounded-sm bg-bg-muted">
              {w.spans.map((s, i) => {
                const start = Math.max(fromMs, new Date(s.startedAt).getTime());
                const end = Math.min(nowMs, s.endedAt ? new Date(s.endedAt).getTime() : nowMs);
                if (end <= start) return null;
                const leftPct = ((start - fromMs) / span) * 100;
                const widthPct = ((end - start) / span) * 100;
                return (
                  <div
                    // Spans within a worker are non-overlapping and ordered by startedAt, so
                    // (workerId, index) is a stable key — no need for a synthetic span id.
                    key={`${w.workerId}-${i}`}
                    title={`${s.status}: ${new Date(start).toLocaleString()} → ${
                      s.endedAt ? new Date(s.endedAt).toLocaleString() : "now"
                    }`}
                    className="absolute top-0 h-full"
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      backgroundColor: statusColor[s.status],
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}

        <div />
        <div className="relative h-5 text-xs text-text-muted">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${t.leftPct}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
