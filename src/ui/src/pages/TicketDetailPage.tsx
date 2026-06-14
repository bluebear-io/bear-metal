import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useConfig, useTicketDetail } from "../api/queries.js";
import type {
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

const TicketSummary = ({ ticket, maxIterations }: { ticket: Ticket; maxIterations: number | undefined }) => {
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
          <dt className="text-xs font-medium uppercase text-text-muted">Status</dt>
          <dd className="mt-1">
            <StatusBadge status={ticket.bmStatus} />
          </dd>
        </div>
        <Field label="Linear status" value={`${ticket.linearStatusName} (${ticket.linearStatusType})`} />
        <Field label="Attempts" value={`${ticket.attemptCount} / ${maxIterations ?? "?"}`} />
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
          <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-xs font-medium leading-5 text-text-secondary">{pullRequest.draft ? "Draft" : "Ready"}</span>
          <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-xs font-medium leading-5 text-text-secondary">{pullRequest.merged ? "Merged" : "Unmerged"}</span>
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


const PullRequestSection = ({ pullRequests }: { pullRequests: PullRequest[] }) => (
  <Section title="Pull requests">
    <div className="rounded-md border border-border-default bg-bg-card">
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
  </Section>
);

// ---- Unified event log --------------------------------------------------

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

type LogItem =
  | { kind: "toolcall"; ts: number; data: RunToolCall }
  | { kind: "event"; ts: number; data: TicketEvent };

function buildLog(runs: Run[], events: TicketEvent[]): LogItem[] {
  const items: LogItem[] = [
    ...events.map((e) => ({ kind: "event" as const, ts: new Date(e.createdAt).getTime(), data: e })),
    ...runs.flatMap((r) =>
      (r.toolCalls ?? []).map((tc) => ({ kind: "toolcall" as const, ts: new Date(tc.createdAt).getTime(), data: tc }))
    ),
  ];
  return items.sort((a, b) => a.ts - b.ts);
}

const STATUS_BADGE: Record<string, string> = {
  ok: "bg-status-green/10 text-status-green",
  error: "bg-status-red/10 text-status-red",
  unknown: "bg-status-yellow/10 text-status-yellow",
};

const ERROR_EVENT_TYPES = new Set(["worker_crashed", "error"]);

const LogRow = ({ item }: { item: LogItem }) => {
  const [open, setOpen] = useState(false);

  const isToolCall = item.kind === "toolcall";
  const tc = isToolCall ? item.data : null;
  const ev = !isToolCall ? item.data : null;

  const label = isToolCall ? "agent" : ev!.source;
  const statusKey = isToolCall
    ? (tc!.resultStatus ?? "unknown")
    : (ERROR_EVENT_TYPES.has(ev!.type) ? "error" : "ok");
  const badgeClass = STATUS_BADGE[statusKey] ?? STATUS_BADGE.unknown;

  return (
    <>
      <tr
        className="cursor-pointer hover:bg-bg-page"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <td className="whitespace-nowrap px-4 py-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>
            {statusKey}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-3">
          <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">
            {label}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-text-primary">
          {isToolCall
            ? <span className="flex items-center gap-2">
                <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">tool</span>
                <span className="font-mono text-sm">{tc!.toolName}</span>
              </span>
            : ev!.summary}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-text-muted">
          <time dateTime={item.data.createdAt}>{formatDateTime(item.data.createdAt)}</time>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="border-t border-border-default bg-bg-page px-4 py-3 max-w-0 w-full">
            <div className="flex flex-col gap-3 overflow-hidden">
              {isToolCall && tc ? (
                <>
                  {tc.thoughtText && (
                    <div>
                      <div className="text-xs font-semibold uppercase text-text-muted">Thought</div>
                      <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-text-primary">{tc.thoughtText}</pre>
                    </div>
                  )}
                  <div>
                    <div className="text-xs font-semibold uppercase text-text-muted">Input</div>
                    <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary">{prettyJson(tc.argsJson)}</pre>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase text-text-muted">Output</div>
                    {tc.resultText === null ? (
                      <p className="mt-1 text-xs text-text-muted">No result captured.</p>
                    ) : (
                      <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary whitespace-pre-wrap break-words">{tc.resultText}</pre>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-1 text-sm text-text-secondary">
                  <span><span className="font-medium text-text-muted">source:</span> {ev!.source}</span>
                  <span><span className="font-medium text-text-muted">type:</span> {ev!.type.replaceAll("_", " ")}</span>
                  <span><span className="font-medium text-text-muted">summary:</span> {ev!.summary}</span>
                  {ev!.payloadJson && (() => {
                    if (ev!.type === "agent_started") {
                      try {
                        const parsed = JSON.parse(ev!.payloadJson) as { prompt?: string };
                        if (parsed.prompt) {
                          return <pre className="mt-1 max-h-96 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary whitespace-pre-wrap">{parsed.prompt}</pre>;
                        }
                      } catch { /* fall through */ }
                    }
                    return <pre className="mt-1 max-h-64 overflow-auto rounded border border-border-default bg-bg-card p-2 text-xs text-text-primary">{prettyJson(ev!.payloadJson)}</pre>;
                  })()}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

const ACTIVE_RUN_STATUSES = new Set(["running", "dispatched"]);

const EventLogSection = ({ runs, events }: { runs: Run[]; events: TicketEvent[] }) => {
  const items = buildLog(runs, events);
  const isActive = runs.some((r) => r.status !== null && ACTIVE_RUN_STATUSES.has(r.status));
  return (
    <Section title="Event log">
      {items.length === 0 && !isActive ? (
        <p className="text-sm text-text-muted">No events yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
          <table className="min-w-full divide-y divide-border-default text-left text-sm">
            <thead className="bg-bg-page text-xs uppercase text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Source</th>
                <th scope="col" className="px-4 py-3 font-medium">Event</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {items.map((item) => (
                <LogRow key={item.kind === "toolcall" ? `tc-${item.data.id}` : `ev-${item.data.id}`} item={item} />
              ))}
              {isActive && (
                <tr>
                  <td colSpan={4} className="px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <span className="relative flex size-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex size-2 rounded-full bg-primary" />
                      </span>
                      Worker is active — new events will appear here
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
};

export const TicketDetailPage = () => {
  const { id } = useParams();
  const hasTicketId = id !== undefined && id.trim() !== "";
  const query = useTicketDetail(id ?? "");
  const configQuery = useConfig();
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
            <TicketSummary ticket={detail.ticket} maxIterations={configQuery.data?.maxIterations} />
            <PullRequestSection pullRequests={detail.pullRequests} />
            <RunsSection runs={detail.runs} />
            <EventLogSection runs={detail.runs} events={detail.events} />
          </div>
        )}
      </QueryBoundary>
    </main>
  );
};

export default TicketDetailPage;
