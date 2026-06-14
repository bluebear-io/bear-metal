import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useSummary } from "../api/queries.js";
import type {
  CostBlock,
  HealthBlock,
  PeriodSummary,
  ShippedRepoBucket,
  ThroughputBlock,
  TicketRef,
  TimeBlock,
} from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { formatPercent, formatSeconds, formatTokens } from "../lib/format.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

type Preset = "24h" | "week" | "custom";

interface ResolvedRange {
  preset: Preset;
  from: Date;
  to: Date;
}

/** Round to whole seconds so URL params stay stable across re-renders. */
function nowFloor(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function resolveRange(searchParams: URLSearchParams): ResolvedRange {
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  if (fromParam && toParam) {
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to) {
      const duration = to.getTime() - from.getTime();
      // Round to the nearest preset to keep the chip selection sticky across reloads.
      const preset: Preset = Math.abs(duration - DAY_MS) < 60_000 ? "24h"
        : Math.abs(duration - WEEK_MS) < 60_000 ? "week"
        : "custom";
      return { preset, from, to };
    }
  }
  const to = nowFloor();
  const from = new Date(to.getTime() - WEEK_MS);
  return { preset: "week", from, to };
}

function rangeFromPreset(preset: Exclude<Preset, "custom">): { from: Date; to: Date } {
  const to = nowFloor();
  const span = preset === "24h" ? DAY_MS : WEEK_MS;
  return { from: new Date(to.getTime() - span), to };
}

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export default function SummaryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = useMemo(() => resolveRange(searchParams), [searchParams]);
  const summaryQuery = useSummary({ from: range.from, to: range.to });

  const setPreset = (preset: Exclude<Preset, "custom">) => {
    const { from, to } = rangeFromPreset(preset);
    setSearchParams({ from: from.toISOString(), to: to.toISOString() });
  };

  const setCustom = (fromStr: string, toStr: string) => {
    const from = new Date(`${fromStr}T00:00:00.000Z`);
    const to = new Date(`${toStr}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return;
    setSearchParams({ from: from.toISOString(), to: to.toISOString() });
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Summary">
        <PeriodPicker range={range} onPreset={setPreset} onCustom={setCustom} />
        <RefreshButton busy={summaryQuery.isFetching} onClick={() => void summaryQuery.refetch()} />
      </PageHeader>

      <QueryBoundary
        isLoading={summaryQuery.isLoading}
        error={summaryQuery.error}
        isEmpty={summaryQuery.data === undefined}
        emptyLabel="No data for this window."
      >
        {summaryQuery.data && <SummaryCards summary={summaryQuery.data} />}
      </QueryBoundary>
    </main>
  );
}

/* ------------------------------------------------------------------------- */
/*                             Period picker                                 */
/* ------------------------------------------------------------------------- */

const chipClass = (active: boolean): string =>
  [
    "rounded-md border px-3 py-1.5 text-sm font-medium transition",
    active
      ? "border-primary bg-primary/10 text-primary"
      : "border-border-default bg-bg-card text-text-secondary hover:text-text-primary",
  ].join(" ");

interface PeriodPickerProps {
  range: ResolvedRange;
  onPreset(preset: Exclude<Preset, "custom">): void;
  onCustom(from: string, to: string): void;
}

function PeriodPicker({ range, onPreset, onCustom }: PeriodPickerProps) {
  const [customOpen, setCustomOpen] = useState(range.preset === "custom");
  const [fromInput, setFromInput] = useState(dateOnly(range.from));
  const [toInput, setToInput] = useState(dateOnly(range.to));

  // The picker is a controlled view over the URL: when the URL changes (preset click, back
  // button, bookmarked link), mirror the new range into the local input state so "Apply"
  // doesn't submit stale values.
  useEffect(() => {
    setFromInput(dateOnly(range.from));
    setToInput(dateOnly(range.to));
  }, [range.from, range.to]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={chipClass(range.preset === "24h")} onClick={() => onPreset("24h")}>
        Last 24h
      </button>
      <button type="button" className={chipClass(range.preset === "week")} onClick={() => onPreset("week")}>
        Last week
      </button>
      <button
        type="button"
        className={chipClass(range.preset === "custom" || customOpen)}
        onClick={() => setCustomOpen((v) => !v)}
      >
        Custom
      </button>

      {customOpen && (
        <div className="flex items-center gap-2 rounded-md border border-border-default bg-bg-card px-2 py-1.5 text-sm">
          <input
            type="date"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="bg-transparent text-text-primary outline-none"
            aria-label="From date"
          />
          <span className="text-text-muted">→</span>
          <input
            type="date"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            className="bg-transparent text-text-primary outline-none"
            aria-label="To date"
          />
          <button
            type="button"
            className="rounded-md border border-primary px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
            onClick={() => onCustom(fromInput, toInput)}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/*                              Cards                                        */
/* ------------------------------------------------------------------------- */

function SummaryCards({ summary }: { summary: PeriodSummary }) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ThroughputCard block={summary.throughput} prior={summary.throughput.prior} />
        <HealthCard block={summary.health} prior={summary.health.prior} />
        <CostCard block={summary.cost} prior={summary.cost.prior} />
        <TimeCard block={summary.time} prior={summary.time.prior} />
      </div>
      <FailuresCard block={summary.failures} />
      <ShippedCard block={summary.shipped} />
    </>
  );
}

function Card({ title, headerSlot, children }: { title: string; headerSlot?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">{title}</h2>
        {headerSlot}
      </header>
      {children}
    </section>
  );
}

interface DeltaChipProps {
  current: number | null;
  prior: number | null;
  /** When true, lower current = better (e.g. abandoned tickets). */
  invert?: boolean;
  /** Format helper for absolute delta — defaults to integer. */
  format?(delta: number): string;
}

function DeltaChip({ current, prior, invert, format }: DeltaChipProps) {
  // Treat "no data" as undefined rather than 0 — comparing a null current against a non-null
  // prior used to render a misleading ↓ 80% on quiet windows.
  if (current === null || prior === null) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  if (prior === 0 && current === 0) {
    return <span className="text-xs text-text-muted">—</span>;
  }
  const delta = current - prior;
  const fmt = format ?? ((d: number) => Math.round(d).toString());
  const trend = delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  const isImprovement = invert ? delta < 0 : delta > 0;
  const color = delta === 0
    ? "text-text-muted"
    : isImprovement
      ? "text-status-green"
      : "text-status-red";
  const symbol = trend === "up" ? "↑" : trend === "down" ? "↓" : "→";
  return (
    <span className={`text-xs font-medium ${color}`}>
      {symbol} {fmt(Math.abs(delta))}
    </span>
  );
}

function ThroughputCard({ block, prior }: { block: ThroughputBlock; prior: ThroughputBlock }) {
  return (
    <Card title="Throughput">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Completed" value={block.completed} deltaCurrent={block.completed} deltaPrior={prior.completed} />
        <Stat label="Abandoned" value={block.abandoned} deltaCurrent={block.abandoned} deltaPrior={prior.abandoned} invert />
        <Stat label="Discovered" value={block.discovered} deltaCurrent={block.discovered} deltaPrior={prior.discovered} />
      </div>
    </Card>
  );
}

function HealthCard({ block, prior }: { block: HealthBlock; prior: HealthBlock }) {
  return (
    <Card title="Pipeline health">
      <div className="grid grid-cols-3 gap-3">
        <RatioStat label="Success rate" current={block.successRate} priorVal={prior.successRate} />
        <NumericStat label="Avg attempts" current={block.avgAttempts} priorVal={prior.avgAttempts} digits={2} invert />
        <RatioStat label="Needed >1 attempt" current={block.multiAttemptRate} priorVal={prior.multiAttemptRate} invert />
      </div>
    </Card>
  );
}

function CostCard({ block, prior }: { block: CostBlock; prior: CostBlock }) {
  return (
    <Card title="LLM usage">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Input tokens"
          value={formatTokens(block.promptTokens)}
          deltaCurrent={block.promptTokens}
          deltaPrior={prior.promptTokens}
          deltaFormat={(d) => formatTokens(d)}
        />
        <Stat
          label="Output tokens"
          value={formatTokens(block.completionTokens)}
          deltaCurrent={block.completionTokens}
          deltaPrior={prior.completionTokens}
          deltaFormat={(d) => formatTokens(d)}
        />
      </div>
      {block.byModel.length > 0 && (
        <ul className="mt-1 divide-y divide-border-default border-t border-border-default text-sm">
          {block.byModel.slice(0, 5).map((row) => (
            <li key={`${row.provider}::${row.modelName}`} className="flex items-center justify-between gap-2 py-1.5">
              <span className="truncate text-text-primary">{row.modelName}</span>
              <span className="text-text-secondary">
                {formatTokens(row.promptTokens + row.completionTokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TimeCard({ block, prior }: { block: TimeBlock; prior: TimeBlock }) {
  return (
    <Card title="Time">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Avg wall-clock"
          value={formatSeconds(block.avgWallClockSeconds)}
          deltaCurrent={block.avgWallClockSeconds}
          deltaPrior={prior.avgWallClockSeconds}
          invert
          deltaFormat={(d) => formatSeconds(d)}
        />
        <Stat
          label="Agent time"
          value={formatSeconds(block.totalAgentSeconds)}
          deltaCurrent={block.totalAgentSeconds}
          deltaPrior={prior.totalAgentSeconds}
          deltaFormat={(d) => formatSeconds(d)}
        />
        <Stat
          label="Dev-hours saved"
          value={`${block.devHoursSaved}h`}
          deltaCurrent={block.devHoursSaved}
          deltaPrior={prior.devHoursSaved}
          deltaFormat={(d) => `${Math.round(d)}h`}
        />
      </div>
    </Card>
  );
}

function FailuresCard({ block }: { block: { ticketsAtMaxAttempts: TicketRef[] } }) {
  return (
    <Card title="At iteration limit">
      {block.ticketsAtMaxAttempts.length === 0 ? (
        <p className="text-sm text-text-muted">No tickets at the iteration limit in this window.</p>
      ) : (
        <ul className="divide-y divide-border-default text-sm">
          {block.ticketsAtMaxAttempts.map((t) => (
            <li key={t.id} className="py-1.5">
              <a href={t.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{t.identifier}</a>
              <span className="ml-2 text-text-secondary">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ShippedCard({ block }: { block: { byRepo: ShippedRepoBucket[] } }) {
  return (
    <Card title="What shipped">
      {block.byRepo.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing shipped in this window.</p>
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {block.byRepo.map((b) => `${b.repo.split("/").pop()}: ${b.count}`).join(" · ")}
          </p>
          <div className="flex flex-col gap-3">
            {block.byRepo.map((bucket) => (
              <details key={bucket.repo} className="rounded-md border border-border-default">
                <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-text-primary">
                  {bucket.repo} <span className="text-text-secondary">({bucket.count})</span>
                </summary>
                <ul className="divide-y divide-border-default border-t border-border-default text-sm">
                  {bucket.tickets.map((ticket) => (
                    <li key={ticket.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                      <span className="flex flex-1 flex-wrap items-baseline gap-2">
                        <a href={ticket.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                          {ticket.identifier}
                        </a>
                        <span className="text-text-primary">{ticket.title}</span>
                        {ticket.labels.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {ticket.labels.map((label) => (
                              <span key={label} className="rounded bg-bg-page px-1.5 py-0.5 text-xs text-text-secondary">{label}</span>
                            ))}
                          </span>
                        )}
                      </span>
                      <a href={ticket.prUrl} target="_blank" rel="noreferrer" className="text-sm text-text-secondary hover:underline">
                        PR #{ticket.prNumber}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------- */
/*                              Stat primitives                              */
/* ------------------------------------------------------------------------- */

interface StatProps {
  label: string;
  value: string | number;
  /** null = "no data this window"; DeltaChip will render a dash instead of a misleading delta. */
  deltaCurrent: number | null;
  deltaPrior: number | null;
  invert?: boolean;
  deltaFormat?(delta: number): string;
}

function Stat({ label, value, deltaCurrent, deltaPrior, invert, deltaFormat }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-text-muted">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-text-primary">{value}</span>
        <DeltaChip current={deltaCurrent} prior={deltaPrior} invert={invert} format={deltaFormat} />
      </span>
    </div>
  );
}

function RatioStat({ label, current, priorVal, invert }: { label: string; current: number | null; priorVal: number | null; invert?: boolean }) {
  return (
    <Stat
      label={label}
      value={current === null ? "—" : formatPercent(current)}
      deltaCurrent={current}
      deltaPrior={priorVal}
      invert={invert}
      deltaFormat={(d) => formatPercent(d)}
    />
  );
}

function NumericStat({ label, current, priorVal, digits = 0, invert }: { label: string; current: number | null; priorVal: number | null; digits?: number; invert?: boolean }) {
  return (
    <Stat
      label={label}
      value={current === null ? "—" : current.toFixed(digits)}
      deltaCurrent={current}
      deltaPrior={priorVal}
      invert={invert}
      deltaFormat={(d) => d.toFixed(digits)}
    />
  );
}
