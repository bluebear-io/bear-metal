import type { CSSProperties } from "react";

const toneColorByStatus: Record<string, string> = {
  completed: "var(--color-status-green)",
  passed: "var(--color-status-green)",
  merged: "var(--color-status-green)",
  succeeded: "var(--color-status-green)",
  waiting_for_human: "var(--color-status-orange)",
  healthy: "var(--color-status-green)",
  abandoned: "var(--color-status-red)",
  failed: "var(--color-status-red)",
  crashed: "var(--color-status-red)",
  dead: "var(--color-status-red)",
  ci_failed: "var(--color-status-red)",
  timed_out: "var(--color-status-red)",
  heartbeat_stale: "var(--color-status-orange)",
  in_progress: "var(--color-primary)",
  running: "var(--color-primary)",
  dispatched: "var(--color-primary)",
  busy: "var(--color-primary)",
  ci_running: "var(--color-primary)",
  pr_open: "var(--color-primary)",
  open: "var(--color-primary)",
  discovered: "var(--color-text-muted)",
  idle: "var(--color-text-muted)",
  stopped: "var(--color-text-muted)",
  closed: "var(--color-text-muted)",
  fallback: "var(--color-text-muted)",
};

export interface StatusBadgeProps {
  status: string;
}

const STATUS_LABELS: Partial<Record<string, string>> = {};

const humanizeStatus = (status: string): string => STATUS_LABELS[status] ?? status.replaceAll("_", " ");

export const StatusBadge = ({ status }: StatusBadgeProps) => {
  const color = toneColorByStatus[status] ?? toneColorByStatus.fallback;
  const style = {
    color,
    borderColor: color,
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
  } satisfies CSSProperties;

  return (
    <span
      style={style}
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-5"
    >
      {humanizeStatus(status)}
    </span>
  );
};
