import { Link, useParams } from "react-router-dom";

import { useTicketDetail } from "../api/queries.js";
import type { CiRun, PullRequest, Run, Ticket, TicketEvent } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { RunLogPanel } from "../components/RunLogPanel.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime, formatDuration, parseLabels } from "../lib/format.js";

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

const RunCard = ({ run }: { run: Run }) => (
  <div className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
    <div className="grid gap-3 sm:grid-cols-[auto_auto_minmax(0,1fr)_auto] sm:items-center">
      <span className="text-sm font-medium">Attempt {run.attemptNumber}</span>
      <StatusBadge status={run.status} />
      <span className="text-sm text-text-secondary">
        <span className="mr-3">Trigger: {run.trigger.replaceAll("_", " ")}</span>
        <span className="mr-3">Worker: {run.worker?.name ?? "—"}</span>
        <span>Duration: {formatDuration(run.startedAt, run.endedAt)}</span>
      </span>
      <span className="text-xs text-text-muted">{[run.stopReason, run.error].filter(Boolean).join(": ") || "—"}</span>
    </div>
    <RunLogPanel runId={run.id} />
  </div>
);

const RunsSection = ({ runs }: { runs: Run[] }) => (
  <Section title="Runs">
    {runs.length === 0 ? (
      <p className="text-sm text-text-muted">No runs</p>
    ) : (
      <ul className="flex flex-col gap-3">
        {runs.map((run) => (
          <li key={run.id}>
            <RunCard run={run} />
          </li>
        ))}
      </ul>
    )}
  </Section>
);

const PullRequestRow = ({ pullRequest }: { pullRequest: PullRequest }) => (
  <li className="grid gap-3 border-b border-border-default px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]">
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
  </li>
);

const CiRunRow = ({ ciRun }: { ciRun: CiRun }) => (
  <li className="grid gap-3 border-b border-border-default px-4 py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
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
  </li>
);

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

const TimelineSection = ({ events }: { events: TicketEvent[] }) => (
  <Section title="Timeline">
    {events.length === 0 ? (
      <p className="text-sm text-text-muted">No events</p>
    ) : (
      <ol className="rounded-md border border-border-default bg-bg-card">
        {events.map((event) => (
          <li className="grid gap-2 border-b border-border-default px-4 py-3 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]" key={event.id}>
            <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">
              {event.source} / {event.type.replaceAll("_", " ")}
            </span>
            <span className="text-sm text-text-primary">{event.summary}</span>
            <time className="text-xs text-text-muted" dateTime={event.createdAt}>
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
        error={query.error instanceof Error ? query.error : null}
        isEmpty={detail === undefined}
        emptyLabel="Ticket detail not found"
      >
        {detail === undefined ? null : (
          <div className="flex flex-col gap-6">
            <TicketSummary ticket={detail.ticket} />
            <RunsSection runs={detail.runs} />
            <PullRequestCiSection pullRequests={detail.pullRequests} ciRuns={detail.ciRuns} />
            <TimelineSection events={detail.events} />
          </div>
        )}
      </QueryBoundary>
    </main>
  );
};

export default TicketDetailPage;
