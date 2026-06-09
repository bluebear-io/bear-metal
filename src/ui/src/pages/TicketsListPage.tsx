import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useTicketFilterOptions, useTickets, useWorkers } from "../api/queries.js";
import type {
  BmStatus,
  StopReason,
  TicketFilters,
  TicketListItem,
} from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime } from "../lib/format.js";

const Dash = () => <span className="text-text-muted">-</span>;

const DEFAULT_PAGE_SIZE = 25;

interface FilterState {
  search: string;
  bmStatuses: BmStatus[];
  workerIds: string[];
  labels: string[];
  stopReasons: StopReason[];
  errorSignature: string;
}

const EMPTY_FILTERS: FilterState = {
  search: "",
  bmStatuses: [],
  workerIds: [],
  labels: [],
  stopReasons: [],
  errorSignature: "",
};

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

function getSelectedValues(target: HTMLSelectElement): string[] {
  return Array.from(target.selectedOptions, (o) => o.value);
}

const inputClass =
  "rounded-md border border-border-default bg-bg-card px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-primary focus:outline-none";

interface MultiSelectProps<T extends string> {
  id: string;
  label: string;
  values: readonly T[];
  options: readonly { value: T; label: string }[];
  onChange: (next: T[]) => void;
  size?: number;
}

function MultiSelect<T extends string>({ id, label, values, options, onChange, size = 4 }: MultiSelectProps<T>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs uppercase text-text-muted">
      {label}
      <select
        id={id}
        multiple
        size={Math.min(size, Math.max(options.length, 2))}
        value={values as readonly string[] as string[]}
        onChange={(e) => onChange(getSelectedValues(e.currentTarget) as T[])}
        className={`${inputClass} min-w-[10rem]`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const humanize = (value: string) => value.replaceAll("_", " ");

export default function TicketsListPage() {
  const [draft, setDraft] = useState<FilterState>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const filters: TicketFilters = useMemo(
    () => ({
      search: applied.search || undefined,
      bmStatuses: applied.bmStatuses.length > 0 ? applied.bmStatuses : undefined,
      workerIds: applied.workerIds.length > 0 ? applied.workerIds : undefined,
      labels: applied.labels.length > 0 ? applied.labels : undefined,
      stopReasons: applied.stopReasons.length > 0 ? applied.stopReasons : undefined,
      errorSignature: applied.errorSignature || undefined,
      page,
      pageSize,
    }),
    [applied, page, pageSize],
  );

  const ticketsQuery = useTickets(filters);
  const optionsQuery = useTicketFilterOptions();
  const workersQuery = useWorkers();

  const tickets = ticketsQuery.data?.tickets ?? [];
  const total = ticketsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const statusOptions = useMemo(
    () => (optionsQuery.data?.bmStatuses ?? []).map((s) => ({ value: s, label: humanize(s) })),
    [optionsQuery.data?.bmStatuses],
  );
  const stopReasonOptions = useMemo(
    () => (optionsQuery.data?.stopReasons ?? []).map((s) => ({ value: s, label: humanize(s) })),
    [optionsQuery.data?.stopReasons],
  );
  const labelOptions = useMemo(
    () => (optionsQuery.data?.labels ?? []).map((l) => ({ value: l, label: l })),
    [optionsQuery.data?.labels],
  );
  const workerOptions = useMemo(
    () =>
      (workersQuery.data ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => ({ value: w.id, label: w.name })),
    [workersQuery.data],
  );

  const applyFilters = () => {
    setApplied({
      ...draft,
      search: draft.search.trim(),
      errorSignature: draft.errorSignature.trim(),
    });
    setPage(1);
  };

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Tickets">
        <RefreshButton busy={ticketsQuery.isFetching} onClick={() => void ticketsQuery.refetch()} />
      </PageHeader>

      <section
        aria-label="Ticket search and filters"
        className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4"
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label htmlFor="ticket-search" className="flex flex-1 flex-col gap-1 text-xs uppercase text-text-muted">
              Search
              <input
                id="ticket-search"
                type="search"
                placeholder="identifier, title, description, or branch"
                value={draft.search}
                onChange={(e) => setDraft((d) => ({ ...d, search: e.target.value }))}
                className={inputClass}
              />
            </label>
            <label htmlFor="error-signature" className="flex flex-1 flex-col gap-1 text-xs uppercase text-text-muted">
              Error signature
              <input
                id="error-signature"
                type="search"
                placeholder="substring of run.error"
                value={draft.errorSignature}
                onChange={(e) => setDraft((d) => ({ ...d, errorSignature: e.target.value }))}
                className={inputClass}
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MultiSelect
              id="filter-status"
              label="State"
              values={draft.bmStatuses}
              options={statusOptions}
              onChange={(v) => setDraft((d) => ({ ...d, bmStatuses: v }))}
              size={5}
            />
            <MultiSelect
              id="filter-worker"
              label="Worker"
              values={draft.workerIds}
              options={workerOptions}
              onChange={(v) => setDraft((d) => ({ ...d, workerIds: v }))}
            />
            <MultiSelect
              id="filter-label"
              label="Label"
              values={draft.labels}
              options={labelOptions}
              onChange={(v) => setDraft((d) => ({ ...d, labels: v }))}
            />
            <MultiSelect
              id="filter-stop-reason"
              label="Failure / stop reason"
              values={draft.stopReasons}
              options={stopReasonOptions}
              onChange={(v) => setDraft((d) => ({ ...d, stopReasons: v }))}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-md border border-border-default bg-bg-page px-3 py-1.5 text-sm text-text-primary hover:bg-bg-card"
            >
              Reset
            </button>
            <span className="ml-auto text-xs text-text-muted">
              {ticketsQuery.isLoading
                ? "Loading…"
                : `${total} match${total === 1 ? "" : "es"}`}
            </span>
          </div>
        </form>
      </section>

      <QueryBoundary
        isLoading={ticketsQuery.isLoading}
        error={ticketsQuery.error}
        isEmpty={tickets.length === 0}
        emptyLabel="No tickets match these filters."
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

          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary"
          >
            <div>
              Page {page} of {totalPages} · {total} total
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="page-size" className="text-xs uppercase text-text-muted">
                Page size
                <select
                  id="page-size"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                  className={`ml-2 ${inputClass} py-1`}
                >
                  {[10, 25, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-md border border-border-default bg-bg-card px-3 py-1.5 text-text-primary disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded-md border border-border-default bg-bg-card px-3 py-1.5 text-text-primary disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </nav>
        </section>
      </QueryBoundary>
    </main>
  );
}
