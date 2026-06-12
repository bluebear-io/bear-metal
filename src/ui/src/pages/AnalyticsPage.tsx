import { useAnalytics } from "../api/queries.js";
import type { AnalyticsSummary, AttemptsBucket, ThroughputPoint } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatDurationMs } from "../lib/format.js";

const formatPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

const KpiCard = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="flex flex-col gap-1 rounded-md border border-border-default bg-bg-card p-4">
    <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
    <span className="text-2xl font-semibold text-text-primary">{value}</span>
    {sub !== undefined ? <span className="text-xs text-text-secondary">{sub}</span> : null}
  </div>
);

// -- Charts (raw SVG; recharts is not in this project's deps) --

interface OutcomeBarProps {
  completed: number;
  abandoned: number;
  inFlight: number;
}

const OutcomeBar = ({ completed, abandoned, inFlight }: OutcomeBarProps) => {
  const total = completed + abandoned + inFlight;
  if (total === 0) {
    return <p className="text-sm text-text-muted">No tickets yet.</p>;
  }
  const width = 600;
  const height = 40;
  const cWidth = (completed / total) * width;
  const aWidth = (abandoned / total) * width;
  const iWidth = (inFlight / total) * width;
  return (
    <div className="flex flex-col gap-2">
      <svg
        role="img"
        aria-label="Ticket outcome distribution"
        viewBox={`0 0 ${width} ${height}`}
        className="h-10 w-full"
        preserveAspectRatio="none"
      >
        <rect x={0} y={0} width={cWidth} height={height} className="fill-status-green" />
        <rect x={cWidth} y={0} width={aWidth} height={height} className="fill-status-red" />
        <rect x={cWidth + aWidth} y={0} width={iWidth} height={height} className="fill-status-orange" />
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-text-secondary">
        <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm bg-status-green" />Completed ({completed})</span>
        <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm bg-status-red" />Abandoned ({abandoned})</span>
        <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm bg-status-orange" />In flight ({inFlight})</span>
      </div>
    </div>
  );
};

const AttemptsHistogram = ({ buckets }: { buckets: AttemptsBucket[] }) => {
  if (buckets.length === 0) {
    return <p className="text-sm text-text-muted">No decided tickets yet.</p>;
  }
  const width = 600;
  const height = 220;
  const padding = { top: 12, right: 16, bottom: 32, left: 32 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const max = Math.max(...buckets.map((b) => b.count));
  const barWidth = innerW / buckets.length;
  return (
    <svg
      role="img"
      aria-label="Attempts per ticket distribution"
      viewBox={`0 0 ${width} ${height}`}
      className="h-56 w-full"
    >
      <line x1={padding.left} y1={padding.top + innerH} x2={padding.left + innerW} y2={padding.top + innerH} className="stroke-border-default" />
      {buckets.map((b, i) => {
        const h = max === 0 ? 0 : (b.count / max) * innerH;
        const x = padding.left + i * barWidth + barWidth * 0.15;
        const y = padding.top + innerH - h;
        const w = barWidth * 0.7;
        return (
          <g key={b.attempts}>
            <rect x={x} y={y} width={w} height={h} className="fill-primary" />
            <text x={x + w / 2} y={y - 4} textAnchor="middle" className="fill-text-secondary text-[10px]">
              {b.count}
            </text>
            <text x={x + w / 2} y={padding.top + innerH + 16} textAnchor="middle" className="fill-text-muted text-[10px]">
              {b.attempts}
            </text>
          </g>
        );
      })}
      <text x={padding.left} y={padding.top + innerH + 28} className="fill-text-muted text-[10px]">attempts</text>
    </svg>
  );
};

const ThroughputChart = ({ points }: { points: ThroughputPoint[] }) => {
  if (points.length === 0) {
    return <p className="text-sm text-text-muted">No throughput data yet.</p>;
  }
  const width = 600;
  const height = 220;
  const padding = { top: 12, right: 16, bottom: 36, left: 32 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const max = Math.max(1, ...points.map((p) => Math.max(p.created, p.completed)));
  const groupWidth = innerW / points.length;
  // Show at most ~8 x-axis labels.
  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  return (
    <svg
      role="img"
      aria-label="Ticket volume throughput over time"
      viewBox={`0 0 ${width} ${height}`}
      className="h-56 w-full"
    >
      <line x1={padding.left} y1={padding.top + innerH} x2={padding.left + innerW} y2={padding.top + innerH} className="stroke-border-default" />
      {points.map((p, i) => {
        const x0 = padding.left + i * groupWidth;
        const cH = (p.created / max) * innerH;
        const dH = (p.completed / max) * innerH;
        const barW = groupWidth * 0.35;
        return (
          <g key={p.date}>
            <rect x={x0 + groupWidth * 0.1} y={padding.top + innerH - cH} width={barW} height={cH} className="fill-primary" />
            <rect x={x0 + groupWidth * 0.55} y={padding.top + innerH - dH} width={barW} height={dH} className="fill-status-green" />
            {i % labelStep === 0 ? (
              <text x={x0 + groupWidth / 2} y={padding.top + innerH + 14} textAnchor="middle" className="fill-text-muted text-[10px]">
                {p.date.slice(5)}
              </text>
            ) : null}
          </g>
        );
      })}
      <g transform={`translate(${padding.left}, ${height - 6})`}>
        <rect width={10} height={10} y={-9} className="fill-primary" />
        <text x={14} className="fill-text-secondary text-[10px]">Created</text>
        <rect width={10} height={10} x={70} y={-9} className="fill-status-green" />
        <text x={84} className="fill-text-secondary text-[10px]">Completed</text>
      </g>
    </svg>
  );
};

const AnalyticsView = ({ data }: { data: AnalyticsSummary }) => (
  <div className="flex flex-col gap-6">
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiCard
        label="Success rate"
        value={formatPercent(data.outcomes.successRate)}
        sub={`${data.outcomes.completed}/${data.outcomes.completed + data.outcomes.abandoned} decided`}
      />
      <KpiCard
        label="Abandonment rate"
        value={formatPercent(data.outcomes.abandonmentRate)}
        sub={`${data.outcomes.abandoned} abandoned`}
      />
      <KpiCard
        label="Mean time to resolution"
        value={formatDurationMs(data.mttr.meanMs)}
        sub={
          data.mttr.sampleSize === 0
            ? "no completed tickets"
            : `median ${formatDurationMs(data.mttr.medianMs)} \u00b7 p90 ${formatDurationMs(data.mttr.p90Ms)} \u00b7 n=${data.mttr.sampleSize}`
        }
      />
      <KpiCard
        label="In flight"
        value={String(data.outcomes.inFlight)}
        sub={`of ${data.outcomes.total} total tickets`}
      />
    </section>

    <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
      <h2 className="text-sm font-semibold text-text-primary">Outcomes</h2>
      <OutcomeBar
        completed={data.outcomes.completed}
        abandoned={data.outcomes.abandoned}
        inFlight={data.outcomes.inFlight}
      />
    </section>

    <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
      <h2 className="text-sm font-semibold text-text-primary">Attempts per ticket</h2>
      <p className="text-xs text-text-muted">Decided tickets (completed or abandoned), bucketed by total attempts.</p>
      <AttemptsHistogram buckets={data.attemptsDistribution} />
    </section>

    <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
      <h2 className="text-sm font-semibold text-text-primary">Ticket throughput</h2>
      <p className="text-xs text-text-muted">Daily tickets created vs. completed (UTC).</p>
      <ThroughputChart points={data.throughput} />
    </section>
  </div>
);

export default function AnalyticsPage() {
  const analyticsQuery = useAnalytics();
  const data = analyticsQuery.data;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Analytics">
        <RefreshButton busy={analyticsQuery.isFetching} onClick={() => void analyticsQuery.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={analyticsQuery.isLoading}
        error={analyticsQuery.error}
        isEmpty={data !== undefined && data.outcomes.total === 0}
        emptyLabel="No analytics data yet."
      >
        {data === undefined ? null : <AnalyticsView data={data} />}
      </QueryBoundary>
    </main>
  );
}
