import { useState } from "react";

import { useRunThoughtTree } from "../api/queries.js";
import type { Run, RunToolCallStep } from "../api/types.js";
import { formatDateTime } from "../lib/format.js";

const stepLabel = (step: RunToolCallStep): string => {
  if (step.kind === "thought") return "Thought";
  return step.toolName ?? "Tool call";
};

const stepBadgeClass = (step: RunToolCallStep): string => {
  if (step.kind === "thought") return "border-border-default text-text-secondary";
  if (step.status === "error") return "border-status-red/40 text-status-red";
  if (step.status === "success") return "border-status-green/40 text-status-green";
  return "border-border-default text-text-secondary";
};

const StepRow = ({ step }: { step: RunToolCallStep }) => {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-border-default last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-left hover:bg-bg-page"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-mono text-xs text-text-muted">{step.sequence + 1}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${stepBadgeClass(step)}`}>
          {step.kind === "thought" ? "thought" : step.status ?? "tool"}
        </span>
        <span className="truncate text-sm text-text-primary">
          <span className="font-medium">{stepLabel(step)}</span>
          {step.kind === "tool_call" && step.paramsJson ? (
            <span className="ml-2 text-text-muted">{step.paramsJson.slice(0, 120)}</span>
          ) : null}
          {step.kind === "thought" && step.thoughtText ? (
            <span className="ml-2 text-text-muted">{step.thoughtText.slice(0, 120)}</span>
          ) : null}
        </span>
        <time className="text-xs text-text-muted" dateTime={step.startedAt}>
          {formatDateTime(step.startedAt)}
        </time>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border-default bg-bg-page px-4 py-3 text-xs">
          {step.kind === "tool_call" ? (
            <>
              {step.paramsJson === null ? null : (
                <details open>
                  <summary className="cursor-pointer font-medium text-text-secondary">Parameters</summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-text-primary">{step.paramsJson}</pre>
                </details>
              )}
              {step.resultText === null ? null : (
                <details open>
                  <summary className="cursor-pointer font-medium text-text-secondary">
                    Result{step.resultSize !== null ? ` (${step.resultSize} chars)` : ""}
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-text-primary">{step.resultText}</pre>
                </details>
              )}
            </>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-text-primary">{step.thoughtText ?? ""}</pre>
          )}
        </div>
      ) : null}
    </li>
  );
};

const RunThoughtTree = ({ run }: { run: Run }) => {
  const query = useRunThoughtTree(run.id);
  const steps = query.data?.steps ?? [];

  return (
    <div className="rounded-md border border-border-default bg-bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-2 text-sm">
        <span className="font-medium">Attempt {run.attemptNumber}</span>
        <span className="text-xs text-text-muted">
          {query.isLoading
            ? "Loading…"
            : query.error
              ? "Failed to load"
              : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {steps.length === 0 ? (
        <p className="px-4 py-3 text-sm text-text-muted">
          {query.isLoading ? "Loading thought tree…" : "No tool calls or thoughts recorded yet."}
        </p>
      ) : (
        <ol>
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
};

export const ThoughtTreeSection = ({ runs }: { runs: Run[] }) => {
  if (runs.length === 0) {
    return <p className="text-sm text-text-muted">No runs yet — no thought tree to show.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {runs.map((run) => (
        <RunThoughtTree key={run.id} run={run} />
      ))}
    </div>
  );
};
