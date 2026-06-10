import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useTickets } from "../api/queries.js";
import type { BmStatus, TicketListItem } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime } from "../lib/format.js";

const Dash = () => <span className="text-text-muted">-</span>;

const TicketLink = ({ ticket }: { ticket: TicketListItem }) => (
  <Link
    to={`/tickets/${ticket.id}`}
    className="font-medium text-primary transition hover:text-text-primary hover:underline"
  >
    {ticket.identifier}
  </Link>
);

const PrLink = ({ ticket }: { ticket: TicketListItem }) => {
  if (ticket.latestPr === null) {
    return <Dash />;
  }

  return (
    <a
      href={ticket.latestPr.url}
      className="font-medium text-primary transition hover:text-text-primary hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      #{ticket.latestPr.number}
    </a>
  );
};

type FilterKey = "all" | "backlog" | "in_progress" | "failed" | "completed";

// Map each filter category to the set of bmStatus values it covers. "backlog" is
// the unstarted bucket (assigned to bear-metal but not yet picked up), and
// "failed" is the human-resolution bucket (CI failed or attempts exhausted).
const FILTER_STATUSES: Record<Exclude<FilterKey, "all">, ReadonlyArray<BmStatus>> = {
  backlog: ["discovered"],
  in_progress: ["dispatched", "in_progress", "pr_open", "ci_running"],
  failed: ["ci_failed", "abandoned"],
  completed: ["completed"],
};

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "backlog", label: "Backlog" },
  { key: "in_progress", label: "In progress" },
  { key: "failed", label: "Needs human" },
  { key: "completed", label: "Completed" },
];

function matchesFilter(ticket: TicketListItem, filter: FilterKey): boolean {
  if (filter === "all") {
    return true;
  }

  return FILTER_STATUSES[filter].includes(ticket.bmStatus);
}

export default function TicketsListPage() {
  const q = useTickets();
  const tickets = useMemo<TicketListItem[]>(() => q.data ?? [], [q.data]);
  const [filter, setFilter] = useState<FilterKey>("all");

  const counts = useMemo(() => {
    const result: Record<FilterKey, number> = {
      all: tickets.length,
      backlog: 0,
      in_progress: 0,
      failed: 0,
      completed: 0,
    };

    for (const ticket of tickets) {
      for (const key of Object.keys(FILTER_STATUSES) as Array<Exclude<FilterKey, "all">>) {
        if (FILTER_STATUSES[key].includes(ticket.bmStatus)) {
          result[key] += 1;
        }
      }
    }

    return result;
  }, [tickets]);

  const visibleTickets = useMemo(
    () => tickets.filter((ticket) => matchesFilter(ticket, filter)),
    [tickets, filter],
  );

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Tickets">
        <RefreshButton busy={q.isFetching} onClick={() => void q.refetch()} />
      </PageHeader>

      <nav aria-label="Ticket filters" className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label }) => {
          const isActive = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={isActive}
              className={
                "rounded-full border px-3 py-1 text-sm transition " +
                (isActive
                  ? "border-primary bg-primary/10 text-text-primary"
                  : "border-border-default bg-bg-card text-text-secondary hover:text-text-primary")
              }
            >
              {label}
              <span className="ml-2 text-xs text-text-muted">{counts[key]}</span>
            </button>
          );
        })}
      </nav>

      <QueryBoundary
        isLoading={q.isLoading}
        error={q.error}
        isEmpty={visibleTickets.length === 0}
        emptyLabel={filter === "all" ? "No tickets yet." : "No tickets match this filter."}
      >
        <section aria-label="Tickets list" className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
            <table className="min-w-full divide-y divide-border-default text-left text-sm">
              <thead className="bg-bg-page text-xs uppercase text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Ticket</th>
                  <th scope="col" className="px-4 py-3 font-medium">Title</th>
                  <th scope="col" className="px-4 py-3 font-medium">BM status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Latest run</th>
                  <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                  <th scope="col" className="px-4 py-3 font-medium">CI</th>
                  <th scope="col" className="px-4 py-3 font-medium">PR</th>
                  <th scope="col" className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {visibleTickets.map((ticket) => (
                  <tr key={ticket.id} className="align-middle">
                    <td className="whitespace-nowrap px-4 py-3">
                      <TicketLink ticket={ticket} />
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-text-primary">{ticket.title}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusBadge status={ticket.bmStatus} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {ticket.latestRun === null ? <Dash /> : <StatusBadge status={ticket.latestRun.status} />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-primary">
                      {ticket.attemptCount}/{ticket.maxAttempts}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {ticket.latestCiStatus === null ? <Dash /> : <StatusBadge status={ticket.latestCiStatus} />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <PrLink ticket={ticket} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                      {formatDateTime(ticket.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </QueryBoundary>
    </main>
  );
}
