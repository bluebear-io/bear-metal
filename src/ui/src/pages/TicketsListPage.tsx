import { Link } from "react-router-dom";

import { useTickets } from "../api/queries.js";
import type { TicketListItem } from "../api/types.js";
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

export default function TicketsListPage() {
  const q = useTickets();
  const tickets = q.data ?? [];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Tickets">
        <RefreshButton busy={q.isFetching} onClick={() => void q.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={q.isLoading}
        error={q.error}
        isEmpty={tickets.length === 0}
        emptyLabel="No tickets yet."
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
                {tickets.map((ticket) => (
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
