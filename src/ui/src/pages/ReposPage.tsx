import { useRepos } from "../api/queries.js";
import type { RepoBreakdown } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatDateTime } from "../lib/format.js";

const dash = "—";

const successRateClass = (rate: number): string => {
  if (rate >= 0.7) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200";
  if (rate >= 0.4) return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200";
};

const SuccessRateBadge = ({ rate }: { rate: number | null }) => {
  if (rate === null) return <span className="text-text-muted">{dash}</span>;
  const pct = Math.round(rate * 100);
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${successRateClass(rate)}`}>
      {pct}%
    </span>
  );
};

const formatAvgIterations = (avg: number | null): string => {
  if (avg === null) return dash;
  return avg.toFixed(1);
};

const repoUrl = (repo: RepoBreakdown): string => `https://github.com/${repo.owner}/${repo.repo}`;

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
              {repos.map((repo) => (
                <tr key={`${repo.owner}/${repo.repo}`} className="align-top">
                  <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-text-primary">
                    <a href={repoUrl(repo)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {repo.owner}/{repo.repo}
                    </a>
                  </th>
                  <td className="px-4 py-3 text-text-secondary">{repo.ticketCount}</td>
                  <td className="px-4 py-3 text-text-secondary">{repo.mergedCount}</td>
                  <td className="px-4 py-3"><SuccessRateBadge rate={repo.successRate} /></td>
                  <td className="px-4 py-3 text-text-secondary">{formatAvgIterations(repo.avgIterations)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{formatDateTime(repo.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryBoundary>
    </main>
  );
}
