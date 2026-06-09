import { Link } from "react-router-dom";

import { useTimeSaved } from "../api/queries.js";
import type { TicketTimeSaving } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";

const Dash = () => <span className="text-text-muted">—</span>;

const formatHours = (h: number | null): string => {
  if (h === null) return "—";
  return `${h.toFixed(1)}h`;
};

interface StatCardProps {
  label: string;
  value: string;
  emphasis?: boolean;
}

const StatCard = ({ label, value, emphasis = false }: StatCardProps) => (
  <div className="rounded-md border border-border-default bg-bg-card p-4">
    <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
    <div
      className={[
        "mt-1",
        emphasis ? "text-3xl font-bold text-primary" : "text-2xl font-semibold text-text-primary",
      ].join(" ")}
    >
      {value}
    </div>
  </div>
);

const ComplexityBadge = ({ score }: { score: number | null }) => {
  if (score === null) return <Dash />;
  return (
    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border-default bg-bg-muted px-2 text-xs font-medium text-text-primary">
      {score}
    </span>
  );
};

const TicketRow = ({ row }: { row: TicketTimeSaving }) => (
  <tr className="align-middle">
    <td className="whitespace-nowrap px-4 py-3">
      <Link
        to={`/tickets/${row.ticketId}`}
        className="font-medium text-primary transition hover:text-text-primary hover:underline"
      >
        {row.ticketIdentifier}
      </Link>
    </td>
    <td className="max-w-md truncate px-4 py-3 text-text-primary">{row.ticketTitle}</td>
    <td className="whitespace-nowrap px-4 py-3">
      <ComplexityBadge score={row.complexityScore} />
    </td>
    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{formatHours(row.estimatedHumanHours)}</td>
    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{formatHours(row.actualBmHours)}</td>
    <td className="whitespace-nowrap px-4 py-3 font-medium text-text-primary">{formatHours(row.savedHours)}</td>
  </tr>
);

export default function TimeSavedPage() {
  const q = useTimeSaved();
  const summary = q.data;
  const rows = summary?.byTicket ?? [];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Time Saved">
        <RefreshButton busy={q.isFetching} onClick={() => void q.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={q.isLoading}
        error={q.error}
        isEmpty={summary !== undefined && summary.ticketCount === 0}
        emptyLabel="No completed tickets yet — time savings will appear here once bear-metal ships its first PR."
      >
        {summary !== undefined && (
          <>
            <section aria-label="Time saved summary" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label="Estimated human hours" value={formatHours(summary.totalEstimatedHumanHours)} />
              <StatCard label="Bear-metal hours" value={formatHours(summary.totalActualBmHours)} />
              <StatCard label="Hours saved" value={formatHours(summary.totalSavedHours)} emphasis />
            </section>

            <section aria-label="Per-ticket time saved" className="flex flex-col gap-3">
              <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
                <table className="min-w-full divide-y divide-border-default text-left text-sm">
                  <thead className="bg-bg-page text-xs uppercase text-text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">Ticket</th>
                      <th scope="col" className="px-4 py-3 font-medium">Title</th>
                      <th scope="col" className="px-4 py-3 font-medium">Complexity</th>
                      <th scope="col" className="px-4 py-3 font-medium">Est. human hours</th>
                      <th scope="col" className="px-4 py-3 font-medium">Bear-metal hours</th>
                      <th scope="col" className="px-4 py-3 font-medium">Saved hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-default">
                    {rows.map((row) => (
                      <TicketRow key={row.ticketId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </QueryBoundary>
    </main>
  );
}
