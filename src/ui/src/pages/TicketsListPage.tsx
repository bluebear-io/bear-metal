import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useConfig, useTicketFilterOptions, useTickets } from "../api/queries.js";
import type { BmStatus, StopReason, TicketListItem, TicketListQuery } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime } from "../lib/format.js";

const Dash = () => <span className="text-text-muted">-</span>;

const TicketLink = ({ ticket }: { ticket: TicketListItem }) => (
  <a
    href={ticket.url}
    className="font-medium text-primary transition hover:underline"
    target="_blank"
    rel="noreferrer"
    onClick={(e) => e.stopPropagation()}
  >
    {ticket.identifier}
  </a>
);

const PrLink = ({ ticket }: { ticket: TicketListItem }) => {
  if (ticket.latestPr === null) {
    return <Dash />;
  }

  return (
    <a
      href={ticket.latestPr.url}
      className="font-medium text-primary transition hover:underline"
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      #{ticket.latestPr.number}
    </a>
  );
};

type FilterKey = "all" | "in_progress" | "validating" | "waiting_for_human" | "completed";

const FILTER_STATUSES: Record<Exclude<FilterKey, "all">, ReadonlyArray<BmStatus>> = {
  in_progress: ["in_progress"],
  validating: ["validating"],
  waiting_for_human: ["waiting_for_human"],
  completed: ["completed"],
};

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "in_progress", label: "In progress" },
  { key: "validating", label: "Validating" },
  { key: "waiting_for_human", label: "Waiting for human" },
  { key: "completed", label: "Completed" },
];

const PAGE_SIZE = 50;

const selectClasses =
  "rounded-md border border-border-default bg-bg-card px-2 py-1 text-sm text-text-primary " +
  "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export default function TicketsListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState<string>("");
  const [appliedSearch, setAppliedSearch] = useState<string>("");
  const [workerId, setWorkerId] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<BmStatus | "">("");
  const [stopReason, setStopReason] = useState<StopReason | "">("");
  const [page, setPage] = useState<number>(1);

  const query = useMemo<TicketListQuery>(() => {
    const q: TicketListQuery = { page, pageSize: PAGE_SIZE };
    if (appliedSearch.trim()) q.q = appliedSearch.trim();
    if (workerId) q.workerIds = [workerId];
    if (label) q.labels = [label];
    if (stopReason) q.stopReasons = [stopReason];
    // The State dropdown is the most specific status filter; when set, it wins over the category
    // pill. Otherwise the active category pill is mapped into bmStatuses so pagination + counts
    // reflect the full filtered result set instead of just the current page.
    if (statusFilter) {
      q.bmStatuses = [statusFilter];
    } else if (filter !== "all") {
      q.bmStatuses = [...FILTER_STATUSES[filter]];
    }
    return q;
  }, [appliedSearch, workerId, label, statusFilter, stopReason, page, filter]);

  const ticketsQuery = useTickets(query);
  const filtersQuery = useTicketFilterOptions();
  const configQuery = useConfig();

  const response = ticketsQuery.data;
  const tickets = response?.tickets ?? [];
  const total = response?.total ?? 0;
  const filterOptions = filtersQuery.data;

  // Category filtering is done on the server (see `query` above), so the current page IS already
  // the filtered set. Per-category badge counts would need a dedicated summary endpoint to be
  // accurate across pages — we intentionally don't show stale per-page counts here.
  const visibleTickets = tickets;

  const hasActiveServerFilter =
    Boolean(appliedSearch.trim()) || Boolean(workerId) || Boolean(label) || Boolean(statusFilter) || Boolean(stopReason);
  const pageSize = response?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setAppliedSearch(searchInput);
  };

  const clearFilters = () => {
    setSearchInput("");
    setAppliedSearch("");
    setWorkerId("");
    setLabel("");
    setStatusFilter("");
    setStopReason("");
    setPage(1);
  };

  const setCategory = (key: FilterKey) => {
    setFilter(key);
    setPage(1);
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Tickets">
        <RefreshButton busy={ticketsQuery.isFetching} onClick={() => void ticketsQuery.refetch()} />
      </PageHeader>

      <section aria-label="Ticket search" className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-3">
        <form role="search" onSubmit={submitSearch} className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="ticket-search">Search tickets</label>
          <input
            id="ticket-search"
            type="search"
            placeholder="Search tickets (identifier, title, description, branch)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className={`${selectClasses} min-w-[20rem] flex-1`}
          />
          <button
            type="submit"
            className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-sm font-medium text-text-primary transition hover:border-primary hover:text-primary"
          >
            Search
          </button>
          {hasActiveServerFilter ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-sm font-medium text-text-primary transition hover:border-primary hover:text-primary"
            >
              Clear
            </button>
          ) : null}
        </form>

        <div className="flex flex-wrap gap-2" aria-label="Ticket filters">
          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Worker
            <select
              aria-label="Filter by worker"
              value={workerId}
              onChange={(e) => { setWorkerId(e.target.value); setPage(1); }}
              className={selectClasses}
            >
              <option value="">Any worker</option>
              {filterOptions?.workers.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Label
            <select
              aria-label="Filter by label"
              value={label}
              onChange={(e) => { setLabel(e.target.value); setPage(1); }}
              className={selectClasses}
            >
              <option value="">Any label</option>
              {filterOptions?.labels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            State
            <select
              aria-label="Filter by state"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value as BmStatus | ""); setPage(1); }}
              className={selectClasses}
            >
              <option value="">Any state</option>
              {(filterOptions?.bmStatuses ?? []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Failure reason
            <select
              aria-label="Filter by failure reason"
              value={stopReason}
              onChange={(e) => { setStopReason(e.target.value as StopReason | ""); setPage(1); }}
              className={selectClasses}
            >
              <option value="">Any reason</option>
              {(filterOptions?.stopReasons ?? []).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <nav aria-label="Ticket categories" className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label: btnLabel }) => {
          const isActive = filter === key;
          const count = key === "all"
            ? Object.values(filterOptions?.statusCounts ?? {}).reduce((s, n) => s + (n ?? 0), 0)
            : FILTER_STATUSES[key].reduce((s, status) => s + (filterOptions?.statusCounts?.[status] ?? 0), 0);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              aria-pressed={isActive}
              className={
                "rounded-full border px-3 py-1 text-sm transition " +
                (isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border-default bg-bg-card text-text-secondary transition hover:border-primary hover:text-primary")
              }
            >
              {btnLabel}
              {count !== undefined && <span className="ml-2 text-xs text-text-muted">{count}</span>}
            </button>
          );
        })}
      </nav>

      <QueryBoundary
        isLoading={ticketsQuery.isLoading}
        error={ticketsQuery.error}
        isEmpty={visibleTickets.length === 0}
        emptyLabel={hasActiveServerFilter || filter !== "all" ? "No tickets match these filters." : "No tickets yet."}
      >
        <section aria-label="Tickets list" className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
            <table className="min-w-full divide-y divide-border-default text-left text-sm">
              <thead className="bg-bg-page text-xs uppercase text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Ticket</th>
                  <th scope="col" className="px-4 py-3 font-medium">Title</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Latest run</th>
                  <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                  <th scope="col" className="px-4 py-3 font-medium">Owner</th>
                  <th scope="col" className="px-4 py-3 font-medium">PR</th>
                  <th scope="col" className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {visibleTickets.map((ticket) => (
                  <tr
                    key={ticket.id}
                    className="align-middle cursor-pointer hover:bg-bg-page"
                    onClick={() => navigate(`/tickets/${ticket.id}`)}
                  >
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
                      {ticket.attemptCount}/{configQuery.data?.maxIterations ?? "?"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                      {ticket.assigneeName ?? <Dash />}
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

          {total > pageSize ? (
            <nav aria-label="Tickets pagination" className="flex items-center justify-between text-sm">
              <span className="text-text-secondary">
                Page {page} of {totalPages} &middot; {total} tickets
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-text-secondary hover:text-text-primary disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-text-secondary hover:text-text-primary disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </section>
      </QueryBoundary>
    </main>
  );
}
