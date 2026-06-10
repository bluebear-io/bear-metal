import { useEffect, useRef, useState } from "react";

import { useRunLogs } from "../api/queries.js";
import type { RunLog, RunLogLevel } from "../api/types.js";
import { formatDateTime } from "../lib/format.js";

interface RunLogPanelProps {
  runId: string;
}

const LEVEL_CLASS: Record<RunLogLevel, string> = {
  debug: "text-text-muted",
  info: "text-text-primary",
  warn: "text-status-orange",
  error: "text-status-red",
};

export const RunLogPanel = ({ runId }: RunLogPanelProps) => {
  const [open, setOpen] = useState(false);
  const query = useRunLogs(runId, open);
  const logs = query.data ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever the visible log set grows; React resets the scroll position
  // otherwise and the most recent line — which is what an operator wants to see — falls off-screen.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, open]);

  return (
    <div className="rounded-md border border-border-default bg-bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-medium text-text-secondary hover:text-text-primary"
        aria-expanded={open}
      >
        <span>{open ? "▾" : "▸"} Console logs ({logs.length})</span>
        {query.isFetching ? <span className="text-xs text-text-muted">Refreshing…</span> : null}
      </button>
      {open ? (
        <div
          ref={scrollRef}
          className="max-h-72 overflow-y-auto border-t border-border-default bg-bg-page p-3 font-mono text-xs"
          role="log"
          aria-live="polite"
        >
          {query.isLoading ? (
            <p className="text-text-muted">Loading…</p>
          ) : query.error instanceof Error ? (
            <p className="text-status-red">Failed to load logs: {query.error.message}</p>
          ) : logs.length === 0 ? (
            <p className="text-text-muted">No log lines yet.</p>
          ) : (
            <ol className="flex flex-col gap-0.5">
              {logs.map((log: RunLog) => (
                <li key={log.id} className={`whitespace-pre-wrap ${LEVEL_CLASS[log.level]}`}>
                  <span className="mr-2 text-text-muted">{formatDateTime(log.timestamp)}</span>
                  <span className="mr-2 uppercase">[{log.level}]</span>
                  <span>{log.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
};
