import { useModelComparison } from "../api/queries.js";
import type { ModelComparisonRow } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatCostUsd, formatPercent, formatSeconds, formatTokens } from "../lib/format.js";

const FAMILY_LABEL: Record<ModelComparisonRow["family"], string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  other: "Other",
};

const FamilyBadge = ({ family }: { family: ModelComparisonRow["family"] }) => (
  <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">
    {FAMILY_LABEL[family]}
  </span>
);

/**
 * Aggregate per-family totals so reviewers can compare Claude vs GPT vs Gemini at a glance.
 * Mirrors the per-model rows below but bucketed by family from the backend.
 */
const aggregateByFamily = (rows: ModelComparisonRow[]): ModelComparisonRow[] => {
  const byFamily = new Map<ModelComparisonRow["family"], ModelComparisonRow>();
  const succeededDurationWeighted = new Map<ModelComparisonRow["family"], { sumSeconds: number; count: number }>();
  for (const row of rows) {
    const existing = byFamily.get(row.family);
    const durBucket = succeededDurationWeighted.get(row.family) ?? { sumSeconds: 0, count: 0 };
    // Weight by runsWithDuration (not totalRuns): the per-model avg only covers runs that
    // had both started_at and ended_at, so we must reconstruct the family-level mean using
    // the same denominator the backend used.
    if (row.avgDurationSeconds !== null && row.runsWithDuration > 0) {
      durBucket.sumSeconds += row.avgDurationSeconds * row.runsWithDuration;
      durBucket.count += row.runsWithDuration;
    }
    succeededDurationWeighted.set(row.family, durBucket);
    if (!existing) {
      byFamily.set(row.family, {
        family: row.family,
        provider: FAMILY_LABEL[row.family],
        modelName: "(all)",
        totalRuns: row.totalRuns,
        succeededRuns: row.succeededRuns,
        successRate: 0,
        avgDurationSeconds: null,
        runsWithDuration: row.runsWithDuration,
        totalPromptTokens: row.totalPromptTokens,
        totalCompletionTokens: row.totalCompletionTokens,
        totalCostUsd: row.totalCostUsd,
        avgCostUsd: 0,
      });
    } else {
      existing.totalRuns += row.totalRuns;
      existing.succeededRuns += row.succeededRuns;
      existing.runsWithDuration += row.runsWithDuration;
      existing.totalPromptTokens += row.totalPromptTokens;
      existing.totalCompletionTokens += row.totalCompletionTokens;
      existing.totalCostUsd += row.totalCostUsd;
    }
  }
  for (const [family, agg] of byFamily) {
    agg.successRate = agg.totalRuns > 0 ? agg.succeededRuns / agg.totalRuns : 0;
    agg.avgCostUsd = agg.totalRuns > 0 ? agg.totalCostUsd / agg.totalRuns : 0;
    const dur = succeededDurationWeighted.get(family);
    agg.avgDurationSeconds = dur && dur.count > 0 ? dur.sumSeconds / dur.count : null;
  }
  return Array.from(byFamily.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);
};

const ModelRow = ({ row }: { row: ModelComparisonRow }) => (
  <tr>
    <td className="whitespace-nowrap px-3 py-2">
      <FamilyBadge family={row.family} />
    </td>
    <td className="whitespace-nowrap px-3 py-2 font-medium text-text-primary">{row.modelName}</td>
    <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{row.provider}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{row.totalRuns}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{formatPercent(row.successRate)}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{formatSeconds(row.avgDurationSeconds)}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{formatTokens(row.totalPromptTokens)}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{formatTokens(row.totalCompletionTokens)}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right text-text-secondary">{formatCostUsd(row.avgCostUsd)}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-text-primary">{formatCostUsd(row.totalCostUsd)}</td>
  </tr>
);

const ModelTable = ({ rows, title }: { rows: ModelComparisonRow[]; title: string }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-semibold uppercase text-text-secondary">{title}</h2>
    {rows.length === 0 ? (
      <p className="text-sm text-text-muted">No data</p>
    ) : (
      <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
        <table className="min-w-full divide-y divide-border-default text-left text-sm">
          <thead className="text-xs uppercase text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Family</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 text-right font-medium">Runs</th>
              <th className="px-3 py-2 text-right font-medium">Success</th>
              <th className="px-3 py-2 text-right font-medium">Avg time</th>
              <th className="px-3 py-2 text-right font-medium">Prompt</th>
              <th className="px-3 py-2 text-right font-medium">Completion</th>
              <th className="px-3 py-2 text-right font-medium">Avg $/run</th>
              <th className="px-3 py-2 text-right font-medium">Total $</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {rows.map((row) => <ModelRow key={`${row.provider}::${row.modelName}`} row={row} />)}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

export const ModelsPage = () => {
  const query = useModelComparison();
  const rows = query.data ?? [];
  const familyRows = aggregateByFamily(rows);

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 sm:px-8">
      <PageHeader title="Model efficacy">
        <RefreshButton busy={query.isFetching} onClick={() => void query.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={rows.length === 0}
        emptyLabel="No model usage recorded yet"
      >
        <div className="flex flex-col gap-8">
          <ModelTable rows={familyRows} title="By family (Claude vs GPT vs Gemini)" />
          <ModelTable rows={rows} title="By model" />
        </div>
      </QueryBoundary>
    </main>
  );
};

export default ModelsPage;
