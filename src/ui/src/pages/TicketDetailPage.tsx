import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useTicketDetail } from "../api/queries.js";
import type {
  CiCheck,
  CiRun,
  PullRequest,
  ReviewThread,
  ReviewThreadComment,
  Run,
  RunToolCall,
  Ticket,
  TicketEvent,
} from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime, formatDuration, formatTokens, parseLabels } from "../lib/format.js";

const Field = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0">
    <dt className="text-xs font-medium uppercase text-text-muted">{label}</dt>
    <dd className="mt-1 truncate text-sm text-text-primary">{value}</dd>
  </div>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold uppercase text-text-secondary">{title}</h2>
    {children}
  </section>
);

const TicketSummary = ({ ticket }: { ticket: Ticket }) => {
  const labels = parseLabels(ticket.labelsJson);

  return (
    <Section title="Summary">
      <dl className="grid gap-4 rounded-md border border-border-default bg-bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase text-text-muted">Identifier</dt>
          <dd className="mt-1">
            <a href={ticket.url} className="text-sm font-medium text-primary hover:underline">
              {ticket.identifier}
            </a>
          </dd>
        </div>
        <Field label="Title" value={ticket.title} />
        <div>
          <dt className="text-xs font-medium uppercase text-text-muted">BM status</dt>
          <dd className="mt-1">
            <StatusBadge status={ticket.bmStatus} />
          </dd>
        </div>
        <Field label="Linear status" value={`${ticket.linearStatusName} (${ticket.linearStatusType})`} />
        <Field label="Attempts" value={`${ticket.attemptCount} / ${ticket.maxAttempts}`} />
        <Field label="Branch" value={ticket.branchName} />
        <Field label="Updated" value={formatDateTime(ticket.updatedAt)} />
        <Field label="Completed" value={formatDateTime(ticket.completedAt)} />
        <div className="min-w-0 sm:col-span-2 lg:col-span-4">
          <dt className="text-xs font-medium uppercase text-text-muted">Labels</dt>
          <dd className="mt-2 flex flex-wrap gap-2">
            {labels.length === 0 ? (
              <span className="text-sm text-text-muted">None</span>
            ) : (
              labels.map((label) => (
                <span
                  className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary"
                  key={label}
                >
                  {label}
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>
    </Section>
  );
};

const RunsSection = ({ runs }: { runs: Run[] }) => (
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
              <th className="px-3 py-2 font-medium">Stop / error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {runs.map((run) => (
              <tr key={run.id}>
                <td className="whitespace-nowrap px-3 py-2 font-medium">Attempt {run.attemptNumber}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <StatusBadge status={run.status} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{run.trigger.replaceAll("_", " ")}</td>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{run.worker?.name ?? "—"}</td>
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
                <td className="min-w-48 px-3 py-2 text-text-secondary">{[run.stopReason, run.error].filter(Boolean).join(": ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Section>
);

// Best-effort JSON parser — server stores comments as a JSON string; bad data renders as no comments.
function parseComments(json: string): ReviewThreadComment[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as ReviewThreadComment[]) : [];
  } catch {
    return [];
  }
}

function parseAnnotations(json: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

const ReviewThreadItem = ({ thread }: { thread: ReviewThread }) => {
  const comments = parseComments(thread.commentsJson);
  const location = thread.path
    ? `${thread.path}${thread.line !== null ? `:${thread.line}` : ""}`
    : "general";
  return (
    <li className="border-b border-border-default px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-text-secondary">{location}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            thread.isResolved
              ? "bg-status-green/10 text-status-green"
              : "bg-status-yellow/10 text-status-yellow"
          }`}
        >
          {thread.isResolved ? "Resolved" : "Needs action"}
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {comments.length === 0 ? (
          <li className="text-xs text-text-muted">No comment body</li>
        ) : (
          comments.map((comment) => (
            <li className="text-sm text-text-primary" key={comment.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                <span>{comment.author ?? "unknown"}</span>
                <span>·</span>
                <a href={comment.url} className="text-primary hover:underline">
                  comment
                </a>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
            </li>
          ))
        )}
      </ul>
    </li>
  );
};

const PullRequestRow = ({ pullRequest }: { pullRequest: PullRequest }) => {
  const threads = pullRequest.reviewThreads ?? [];
  const unresolved = threads.filter((t) => !t.isResolved).length;
  return (
    <li className="flex flex-col gap-3 border-b border-border-default px-4 py-3 last:border-b-0">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <a href={pullRequest.url} className="font-medium text-primary hover:underline">
            #{pullRequest.number} {pullRequest.title}
          </a>
          <p className="mt-1 truncate text-xs text-text-muted">{pullRequest.headRef}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={pullRequest.merged ? "merged" : pullRequest.state} />
          <span className="text-xs text-text-secondary">{pullRequest.draft ? "Draft" : "Ready"}</span>
          <span className="text-xs text-text-secondary">{pullRequest.merged ? "Merged" : "Unmerged"}</span>
        </div>
      </div>
      {threads.length > 0 && (
        <div className="rounded-md border border-border-default bg-bg-page">
          <h4 className="border-b border-border-default px-3 py-2 text-xs font-semibold uppercase text-text-secondary">
            Review comments ({unresolved} unresolved / {threads.length} total)
          </h4>
          <ul>
            {threads.map((thread) => (
              <ReviewThreadItem key={thread.id} thread={thread} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
};

const CiCheckItem = ({ check }: { check: CiCheck }) => {
  const annotations = parseAnnotations(check.annotationsJson);
  return (
    <li className="border-b border-border-default px-4 py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {check.detailsUrl ? (
            <a href={check.detailsUrl} className="text-sm font-medium text-primary hover:underline">
              {check.name}
            </a>
          ) : (
            <span className="text-sm font-medium text-text-primary">{check.name}</span>
          )}
          {check.summary && (
            <p className="mt-1 text-xs text-text-secondary whitespace-pre-wrap break-words">{check.summary}</p>
          )}
        </div>
        <span className="rounded-full bg-status-red/10 px-2 py-0.5 text-xs font-medium text-status-red">
          {check.conclusion ?? "failed"}
        </span>
      </div>
      {annotations.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 rounded border border-border-default bg-bg-page px-3 py-2 text-xs text-text-secondary">
          {annotations.slice(0, 5).map((annotation, index) => {
            const path = String(annotation.path ?? "");
            const startLine = annotation.start_line ?? annotation.line ?? null;
            const message = String(annotation.message ?? annotation.title ?? "");
            return (
              <li key={index} className="font-mono">
                <span className="text-text-primary">
                  {path}
                  {startLine !== null ? `:${String(startLine)}` : ""}
                </span>{" "}
                <span>{message}</span>
              </li>
            );
          })}
          {annotations.length > 5 && (
            <li className="text-text-muted">+ {annotations.length - 5} more annotation(s)</li>
          )}
        </ul>
      )}
    </li>
  );
};

const CiRunRow = ({ ciRun }: { ciRun: CiRun }) => {
  const checks = ciRun.checks ?? [];
  return (
    <li className="flex flex-col gap-2 border-b border-border-default px-4 py-3 last:border-b-0">
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <StatusBadge status={ciRun.status} />
        <div className="min-w-0 text-sm text-text-secondary">
          {ciRun.url === null ? (
            <span>{ciRun.summary ?? "No CI summary"}</span>
          ) : (
            <a href={ciRun.url} className="text-primary hover:underline">
              {ciRun.summary ?? "CI run"}
            </a>
          )}
        </div>
        <span className="text-xs text-text-muted">{formatDateTime(ciRun.completedAt ?? ciRun.createdAt)}</span>
      </div>
      {checks.length > 0 && (
        <div className="rounded-md border border-border-default bg-bg-page">
          <h4 className="border-b border-border-default px-3 py-2 text-xs font-semibold uppercase text-text-secondary">
            Failing checks ({checks.length})
          </h4>
          <ul>
            {checks.map((check) => (
              <CiCheckItem key={check.id} check={check} />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
};

const PullRequestCiSection = ({ pullRequests, ciRuns }: { pullRequests: PullRequest[]; ciRuns: CiRun[] }) => (
  <Section title="PR / CI">
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-md border border-border-default bg-bg-card">
        <h3 className="border-b border-border-default px-4 py-2 text-sm font-medium">Pull requests</h3>
        {pullRequests.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text-muted">No pull requests</p>
        ) : (
          <ul>
            {pullRequests.map((pullRequest) => (
              <PullRequestRow key={pullRequest.id} pullRequest={pullRequest} />
            ))}
          </ul>
        )}
      </div>
      <div className="rounded-md border border-border-default bg-bg-card">
        <h3 className="border-b border-border-default px-4 py-2 text-sm font-medium">CI runs</h3>
        {ciRuns.length === 0 ? (
          <p className="px-4 py-3 text-sm text-text-muted">No CI runs</p>
        ) : (
          <ul>
            {ciRuns.map((ciRun) => (
              <CiRunRow key={ciRun.id} ciRun={ciRun} />
            ))}
          </ul>
        )}
      </div>
    </div>
  </Section>
);

// ---- DEN-2311 Thought-process visualizer -------------------------------

const RESULT_STATUS_STYLE: Record<"ok" | "error" | "unknown", string> = {
  ok: "bg-status-green/10 text-status-green",
  error: "bg-status-red/10 text-status-red",
  unknown: "bg-status-yellow/10 text-status-yellow",
};

// Pretty-print stored JSON when possible; bad data falls back to the raw string so the
// operator still sees something useful.
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const ToolCallStep = ({ step, index }: { step: RunToolCall; index: number }) => {
  const [open, setOpen] = useState(false);
  const status = step.resultStatus ?? "unknown";
  return (
    <li className="border-b border-border-default last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-bg-page"
        aria-expanded={open}
      >
        <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-border-default text-xs text-text-secondary">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-text-primary">{step.toolName}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_STATUS_STYLE[status]}`}>
              {status}
            </span>
            {step.outputSize !== null && (
              <span className="text-xs text-text-muted">{step.outputSize.toLocaleString()} chars</span>
            )}
          </span>
          {step.thoughtText && !open && (
            <span className="mt-1 line-clamp-2 block text-xs text-text-secondary whitespace-pre-wrap">{step.thoughtText}</span>
          )}
        </span>
        <span className="mt-1 text-xs text-text-muted">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border-default bg-bg-page px-4 py-3">
          {step.thoughtText && (
            <div>
              <div className="text-xs font-semibold uppercase text-text-muted">Thought</div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-text-primary">{step.thoughtText}</pre>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold uppercase text-text-muted">Input</div>
            <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary">{prettyJson(step.argsJson)}</pre>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase text-text-muted">Output</div>
            {step.resultText === null ? (
              <p className="mt-1 text-xs text-text-muted">No result captured.</p>
            ) : (
              <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary whitespace-pre-wrap break-words">{step.resultText}</pre>
            )}
          </div>
        </div>
      )}
    </li>
  );
};

const ThoughtProcessSection = ({ runs }: { runs: Run[] }) => {
  const runsWithCalls = runs.filter((r) => (r.toolCalls?.length ?? 0) > 0);
  return (
    <Section title="Thought process">
      {runsWithCalls.length === 0 ? (
        <p className="text-sm text-text-muted">No tool calls captured for this ticket’s runs.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {runsWithCalls.map((run) => (
            <div key={run.id} className="rounded-md border border-border-default bg-bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-default px-4 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">Attempt {run.attemptNumber}</span>
                  <StatusBadge status={run.status} />
                </div>
                <span className="text-xs text-text-muted">{run.toolCalls.length} step{run.toolCalls.length === 1 ? "" : "s"}</span>
              </div>
              <ol className="divide-y divide-border-default">
                {run.toolCalls.map((step, index) => (
                  <ToolCallStep key={step.id} step={step} index={index} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
};

const TimelineSection = ({ events }: { events: TicketEvent[] }) => (
  <Section title="Timeline">
    {events.length === 0 ? (
      <p className="text-sm text-text-muted">No events</p>
    ) : (
      <ol className="rounded-md border border-border-default bg-bg-card">
        {events.map((event) => (
          <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-default px-4 py-3 last:border-b-0" key={event.id}>
            <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">
              {event.source} / {event.type.replaceAll("_", " ")}
            </span>
            <span className="text-sm text-text-primary">{event.summary}</span>
            <time className="whitespace-nowrap text-right text-xs text-text-muted" dateTime={event.createdAt}>
              {formatDateTime(event.createdAt)}
            </time>
          </li>
        ))}
      </ol>
    )}
  </Section>
);

export const TicketDetailPage = () => {
  const { id } = useParams();
  const hasTicketId = id !== undefined && id.trim() !== "";
  const query = useTicketDetail(id ?? "");
  const detail = hasTicketId ? query.data : undefined;

  if (!hasTicketId) {
    return (
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-8 sm:px-8">
        <Link to="/tickets" className="text-sm font-medium text-primary hover:underline">
          Back to tickets
        </Link>
        <div role="alert" className="rounded-md border border-status-red/40 bg-bg-card p-3 text-sm text-status-red">
          Missing ticket id.
        </div>
      </main>
    );
  }

  const title = detail === undefined ? `Ticket ${id}` : `${detail.ticket.identifier}: ${detail.ticket.title}`;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 sm:px-8">
      <Link to="/tickets" className="text-sm font-medium text-primary hover:underline">
        Back to tickets
      </Link>

      <PageHeader title={title}>
        <RefreshButton busy={query.isFetching} onClick={() => void query.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={detail === undefined}
        emptyLabel="Ticket detail not found"
      >
        {detail === undefined ? null : (
          <div className="flex flex-col gap-6">
            <TicketSummary ticket={detail.ticket} />
            <RunsSection runs={detail.runs} />
            <ThoughtProcessSection runs={detail.runs} />
            <PullRequestCiSection pullRequests={detail.pullRequests} ciRuns={detail.ciRuns} />
            <TimelineSection events={detail.events} />
          </div>
        )}
      </QueryBoundary>
    </main>
  );
};

export default TicketDetailPage;
