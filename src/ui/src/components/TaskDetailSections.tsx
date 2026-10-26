import { useState } from "react";
import { Link } from "react-router-dom";

import type { AgentRunSummary, Run } from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";
import { formatCostUsd, formatDuration, formatTokens } from "../lib/format.js";

export const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0">
    <dt className="text-xs font-medium uppercase text-text-muted">{label}</dt>
    <dd className="mt-1 truncate text-sm text-text-primary">{value}</dd>
  </div>
);

export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold uppercase text-text-secondary">{title}</h2>
    {children}
  </section>
);

export const RunsSection = ({ runs }: { runs: Array<Run | AgentRunSummary> }) => (
  <Section title="Runs">
    {runs.length === 0 ? (
      <p className="text-sm text-text-muted">No runs</p>
    ) : (
      <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
        <table className="min-w-full divide-y divide-border-default text-left text-sm">
          <thead className="text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Attempt</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Trigger</th>
              <th className="px-3 py-2 font-medium">Worker</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Prompt</th>
              <th className="px-3 py-2 font-medium">Completion</th>
              <th className="px-3 py-2 font-medium">Cost</th>
              <th className="px-3 py-2 font-medium">Stop / error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {runs.map((run) => (
              <tr key={run.id}>
                <td className="whitespace-nowrap px-3 py-2 font-medium"><Link className="text-primary hover:underline" to={`/tasks/run/${run.id}`}>Attempt {run.attemptNumber}</Link></td>
                <td className="whitespace-nowrap px-3 py-2">
                  <StatusBadge status={run.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{"trigger" in run ? run.trigger.replaceAll("_", " ") : run.type}</td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{"worker" in run ? run.worker?.name ?? "—" : run.workerId ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                  {formatDuration(run.startedAt, run.endedAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                  {run.modelName === null ? "—" : (
                    <span title={run.provider ?? undefined}>{run.modelName}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{formatTokens(run.promptTokens)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{formatTokens(run.completionTokens)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{formatCostUsd(run.costUsd)}</td>
                <td className="min-w-48 px-3 py-2 text-text-secondary">{[run.stopReason, run.error].filter(Boolean).join(": ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Section>
);


export function CopyableBlock({ content, tall }: { content: string; tall?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      console.warn("Clipboard write failed");
    });
  };
  return (
    <div className="mt-1">
      <div className="flex items-center justify-end rounded-t border border-b-0 border-border-default bg-bg-card px-2 py-0.5">
        <button
          onClick={copy}
          title="Copy to clipboard"
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
        >
          {copied ? (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              copied
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              copy
            </>
          )}
        </button>
      </div>
      <pre className={`${tall ? "max-h-96" : "max-h-64"} overflow-auto rounded-b border border-border-default bg-bg-card p-2 text-xs text-text-primary whitespace-pre-wrap`}>{content}</pre>
    </div>
  );
}
