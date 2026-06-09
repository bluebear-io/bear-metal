import { useRepos } from "../api/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatDateTime } from "../lib/format.js";

const dash = "—";

// Thresholds: green ≥ 70%, yellow 40–70%, red < 40%. Matches the spec on DEN-2319.
const successRateColorVar = (rate: number): string => {
  if (rate >= 0.7) return "var(--color-status-green)";
  if (rate >= 0.4) return "var(--color-status-orange)";
  return "var(--color-status-red)";
};

const formatSuccessRate = (rate: number | null) => {
  if (rate === null) {
    return <span className="text-text-muted">{dash}</span>;
  }
  const color = successRateColorVar(rate);
  const style = {
    color,
    borderColor: color,
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
  };
  return (
    <span
      style={style}
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-5"
    >
      {Math.round(rate * 100)}%
    </span>
  );
};

const formatAvgIterations = (avg: number | null): string => {
  if (avg === null) {
    return dash;
  }
  return avg.toFixed(1);
};

export default function ReposPage() {
  const reposQuery = useRepos();
  const repos = reposQuery.data ?? [];

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Repos">
        <RefreshButton busy={reposQuery.isFetching} onClick={() => void reposQuery.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={reposQuery.isLoading}
        error={reposQuery.error}
        isEmpty={repos.length === 0}
        emptyLabel="No repository data yet — appears once bear-metal opens its first PR."
      >
        <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
          <table className="min-w-full divide-y divide-border-default text-left text-sm">
            <thead className="bg-bg-muted text-xs font-medium uppercase text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">Repository</th>
                <th scope="col" className="px-4 py-2">Tickets</th>
                <th scope="col" className="px-4 py-2">Merged</th>
                <th scope="col" className="px-4 py-2">Success rate</th>
                <th scope="col" className="px-4 py-2">Avg iterations</th>
                <th scope="col" className="px-4 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-default">
              {repos.map((r) => {
                const slug = `${r.owner}/${r.repo}`;
                return (
                  <tr key={slug} className="align-top">
                    <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-text-primary">
                      <a
                        href={`https://github.com/${r.owner}/${r.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {slug}
                      </a>
                    </th>
                    <td className="px-4 py-3 text-text-secondary">{r.ticketCount}</td>
                    <td className="px-4 py-3 text-text-secondary">{r.mergedCount}</td>
                    <td className="px-4 py-3">{formatSuccessRate(r.successRate)}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatAvgIterations(r.avgIterations)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{formatDateTime(r.lastActivityAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryBoundary>
    </main>
  );
}
