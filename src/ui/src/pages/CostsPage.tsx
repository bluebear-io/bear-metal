import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useBudgetStatus, useCostSummary, useTicketCosts } from "../api/queries.js";
import type { BudgetStatus, CostPeriod, TicketCost } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatDateTime } from "../lib/format.js";

const dash = "—";

const formatUsd = (value: number): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

const formatTokens = (value: number): string => new Intl.NumberFormat().format(value);

const PERIOD_LABELS: Record<CostPeriod, string> = { day: "Today", week: "Last 7 days", month: "Month to date" };
const PERIODS: CostPeriod[] = ["day", "week", "month"];

function burndownColor(percent: number): string {
  if (percent >= 95) return "bg-red-500";
  if (percent >= 80) return "bg-yellow-500";
  return "bg-green-500";
}

function BudgetBurndown({ status }: { status: BudgetStatus }) {
  if (status.monthlyBudgetUsd === null) {
    return null;
  }
  const percent = Math.max(0, Math.min(100, status.percentUsed ?? 0));
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border-default bg-bg-card p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-text-secondary">Monthly budget</span>
        <span className="text-sm text-text-primary">
          {formatUsd(status.spentThisMonthUsd)} / {formatUsd(status.monthlyBudgetUsd)}
          {status.remainingUsd !== null && (
            <span className="ml-2 text-text-muted">({formatUsd(status.remainingUsd)} remaining)</span>
          )}
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-bg-muted">
        <div
          className={`h-3 ${burndownColor(percent)}`}
          style={{ width: `${percent}%` }}
          data-testid="budget-bar"
          aria-label={`${percent.toFixed(1)}% of budget used`}
        />
      </div>
      <span className="text-xs text-text-muted">{(status.percentUsed ?? 0).toFixed(1)}% used</span>
    </section>
  );
}

export default function CostsPage() {
  const [period, setPeriod] = useState<CostPeriod>("month");
  const budgetQuery = useBudgetStatus();
  const summaryQuery = useCostSummary(period);
  const ticketsQuery = useTicketCosts();

  const tickets = useMemo<TicketCost[]>(
    () => [...(ticketsQuery.data ?? [])].sort((a, b) => b.costUsd - a.costUsd),
    [ticketsQuery.data],
  );

  const summary = summaryQuery.data;
  const averagePerTicket = summary && summary.ticketCount > 0 ? summary.totalCostUsd / summary.ticketCount : 0;

  const refreshAll = () => {
    void budgetQuery.refetch();
    void summaryQuery.refetch();
    void ticketsQuery.refetch();
  };

  const isFetching = budgetQuery.isFetching || summaryQuery.isFetching || ticketsQuery.isFetching;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Costs">
        <RefreshButton busy={isFetching} onClick={refreshAll} />
      </PageHeader>

      {budgetQuery.data && <BudgetBurndown status={budgetQuery.data} />}

      <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-secondary">Period:</span>
          <div role="tablist" className="flex gap-1">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => setPeriod(p)}
                className={[
                  "rounded-md px-3 py-1 text-sm font-medium transition",
                  period === p ? "bg-primary text-white" : "bg-bg-muted text-text-secondary hover:bg-bg-page",
                ].join(" ")}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>
        {summary && (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-text-muted">Total spend</div>
              <div className="text-lg font-semibold text-text-primary">{formatUsd(summary.totalCostUsd)}</div>
            </div>
            <div>
              <div className="text-text-muted">Tickets</div>
              <div className="text-lg font-semibold text-text-primary">{summary.ticketCount}</div>
            </div>
            <div>
              <div className="text-text-muted">Avg / ticket</div>
              <div className="text-lg font-semibold text-text-primary">{formatUsd(averagePerTicket)}</div>
            </div>
          </div>
        )}
      </section>

      <QueryBoundary
        isLoading={ticketsQuery.isLoading}
        error={ticketsQuery.error}
        isEmpty={tickets.length === 0}
        emptyLabel="No cost data yet — runs will appear here once bear-metal completes its first dispatch."
      >
        <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
          <table className="min-w-full divide-y divide-border-default text-left text-sm">
            <thead className="bg-bg-muted text-xs font-medium uppercase text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">Ticket</th>
                <th scope="col" className="px-4 py-2">Title</th>
                <th scope="col" className="px-4 py-2 text-right">Input tokens</th>
                <th scope="col" className="px-4 py-2 text-right">Output tokens</th>
                <th scope="col" className="px-4 py-2 text-right">Cost</th>
                <th scope="col" className="px-4 py-2">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {tickets.map((t) => (
                <tr key={t.ticketId} className="align-top">
                  <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-text-primary">
                    <Link to={`/tickets/${encodeURIComponent(t.ticketId)}`} className="text-primary hover:underline">
                      {t.ticketIdentifier}
                    </Link>
                  </th>
                  <td className="px-4 py-3 text-text-secondary">{t.ticketTitle}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-text-secondary">{formatTokens(t.inputTokens)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-text-secondary">{formatTokens(t.outputTokens)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-text-primary">{formatUsd(t.costUsd)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                    {t.completedAt ? formatDateTime(t.completedAt) : dash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryBoundary>
    </main>
  );
}
