import type { Ticket as LinearTicket } from "../../shared/index.js";
import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";
import type { NewCiRun, NewEvent, NewPullRequest, NewRun, NewTicket } from "../db/types.js";
import { type BmStatusPrInput, deriveBmStatus } from "./status.js";
import { type FetchedTicket, prKey, type RowBundle } from "./types.js";

/** Stable id for the single synthetic worker every backfilled run references. */
export const BACKFILL_WORKER_ID = "wk_backfill";

/**
 * Manager's current per-ticket dispatch cap. Hard-coded here because the backfill tool runs
 * standalone and shouldn't depend on the manager's runtime config. Update this if the manager's
 * default changes.
 */
const DEFAULT_MAX_ATTEMPTS = 5;

const isoToDate = (iso: string | null | undefined): Date | null =>
  iso === null || iso === undefined ? null : new Date(iso);

/** Map a single fetched ticket into the rows the writer will insert. */
export function mapTicketBundle(input: FetchedTicket): RowBundle {
  const { ticket, prs, checkRunsByPrKey } = input;
  const sortedPrs = sortPrs(prs);
  const ciStatusByPrKey = new Map<string, BmStatusPrInput["latestCiStatus"]>();
  for (const pr of sortedPrs) {
    ciStatusByPrKey.set(prKey(pr), latestCiStatus(checkRunsByPrKey.get(prKey(pr)) ?? []));
  }

  const bmStatus = deriveBmStatus({
    linearStatusType: ticket.status.type,
    prs: sortedPrs.map<BmStatusPrInput>((pr) => ({
      merged: pr.merged,
      state: pr.state,
      latestCiStatus: ciStatusByPrKey.get(prKey(pr)) ?? null,
    })),
  });

  const runs = synthesizeRuns(ticket, sortedPrs);
  const pullRequests = synthesizePullRequests(ticket, sortedPrs, runs);
  const ciRuns = synthesizeCiRuns(ticket, sortedPrs, runs, checkRunsByPrKey);
  const events = synthesizeEvents(ticket, sortedPrs, runs, ciRuns);

  const ticketRow: NewTicket = {
    id: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    description: ticket.description,
    url: ticket.url,
    branchName: ticket.branchName,
    linearStatusName: ticket.status.name,
    linearStatusType: ticket.status.type,
    labelsJson: JSON.stringify(ticket.labels),
    bmStatus,
    attemptCount: runs.length,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    createdAt: isoToDate(ticket.createdAt) ?? new Date(0),
    updatedAt: isoToDate(ticket.updatedAt) ?? new Date(0),
    completedAt: isoToDate(ticket.completedAt),
  };

  return { ticket: ticketRow, runs, pullRequests, ciRuns, events };
}

/** PRs in deterministic order so synthetic ids and event timestamps are stable across runs. */
function sortPrs(prs: PullRequest[]): PullRequest[] {
  return [...prs].sort((a, b) => {
    const aCreated = a.createdAt ?? "";
    const bCreated = b.createdAt ?? "";
    if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
    return prKey(a).localeCompare(prKey(b));
  });
}

/** Distill a list of check runs down to a single overall status for `bmStatus` derivation. */
function latestCiStatus(runs: CheckRun[]): BmStatusPrInput["latestCiStatus"] {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status !== "completed")) return "running";
  if (runs.some((r) => isFailedConclusion(r.conclusion))) return "failed";
  return "passed";
}

function isFailedConclusion(conclusion: string | null): boolean {
  if (conclusion === null) return false;
  return !["success", "neutral", "skipped"].includes(conclusion);
}

/** Map a GitHub check-run to the dashboard's compact 3-value enum. */
function ciStatusForCheckRun(run: CheckRun): "running" | "passed" | "failed" {
  if (run.status !== "completed") return "running";
  return isFailedConclusion(run.conclusion) ? "failed" : "passed";
}

function synthesizeRuns(ticket: LinearTicket, prs: PullRequest[]): NewRun[] {
  const runs: NewRun[] = [];
  prs.forEach((pr, index) => {
    const status = runStatusForPr(pr);
    const startedAt = isoToDate(pr.createdAt) ?? isoToDate(ticket.createdAt) ?? new Date(0);
    const endedAt = pr.merged
      ? isoToDate(pr.mergedAt)
      : pr.state === "closed"
        ? isoToDate(pr.closedAt) ?? isoToDate(pr.updatedAt)
        : null;
    runs.push({
      id: `run_backfill_${ticket.id}_${index}`,
      ticketId: ticket.id,
      attemptNumber: index + 1,
      workerId: BACKFILL_WORKER_ID,
      trigger: "new",
      status,
      contextJson: null,
      startedAt,
      endedAt,
      stopReason: stopReasonForStatus(status),
      error: null,
      createdAt: startedAt,
    });
  });

  if (runs.length === 0 && ticket.status.type === "canceled") {
    const at = isoToDate(ticket.canceledAt) ?? isoToDate(ticket.updatedAt) ?? new Date(0);
    runs.push({
      id: `run_backfill_${ticket.id}_0`,
      ticketId: ticket.id,
      attemptNumber: 1,
      workerId: BACKFILL_WORKER_ID,
      trigger: "new",
      status: "failed",
      contextJson: null,
      startedAt: isoToDate(ticket.createdAt) ?? at,
      endedAt: at,
      stopReason: "error",
      error: null,
      createdAt: isoToDate(ticket.createdAt) ?? at,
    });
  }

  return runs;
}

function runStatusForPr(pr: PullRequest): NewRun["status"] {
  if (pr.merged) return "succeeded";
  if (pr.state === "open") return "running";
  return "failed";
}

function stopReasonForStatus(status: NewRun["status"]): NewRun["stopReason"] {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "error";
  return null;
}

function synthesizePullRequests(
  ticket: LinearTicket,
  prs: PullRequest[],
  runs: NewRun[],
): NewPullRequest[] {
  return prs.map((pr, index) => ({
    id: `pr_${pr.owner}_${pr.repo}_${pr.number}`,
    ticketId: ticket.id,
    number: pr.number,
    title: pr.title,
    headRef: pr.headRef,
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    url: pr.url,
    lastRunId: runs[index]?.id ?? null,
    createdAt: isoToDate(pr.createdAt) ?? new Date(0),
    updatedAt: isoToDate(pr.updatedAt) ?? new Date(0),
  }));
}

function synthesizeCiRuns(
  ticket: LinearTicket,
  prs: PullRequest[],
  runs: NewRun[],
  checkRunsByPrKey: Map<string, CheckRun[]>,
): NewCiRun[] {
  const ciRuns: NewCiRun[] = [];
  prs.forEach((pr, index) => {
    const runId = runs[index]?.id;
    if (runId === undefined) return;
    const checks = checkRunsByPrKey.get(prKey(pr)) ?? [];
    for (const check of checks) {
      ciRuns.push({
        id: `ci_${pr.owner}_${pr.repo}_${check.id}`,
        ticketId: ticket.id,
        runId,
        prId: `pr_${pr.owner}_${pr.repo}_${pr.number}`,
        status: ciStatusForCheckRun(check),
        url: check.url,
        summary: check.summary,
        createdAt: isoToDate(check.startedAt) ?? isoToDate(pr.createdAt) ?? new Date(0),
        completedAt: isoToDate(check.completedAt),
      });
    }
  });
  return ciRuns;
}

interface PendingEvent {
  ticketId: string | null;
  runId: string | null;
  workerId: string | null;
  source: "manager" | "worker" | "ci";
  type: NonNullable<NewEvent["type"]>;
  summary: string;
  createdAt: Date;
}

function synthesizeEvents(
  ticket: LinearTicket,
  prs: PullRequest[],
  runs: NewRun[],
  ciRuns: NewCiRun[],
): NewEvent[] {
  const pending: PendingEvent[] = [];

  const discoveredAt = isoToDate(ticket.createdAt) ?? new Date(0);
  pending.push({
    ticketId: ticket.id,
    runId: runs[0]?.id ?? null,
    workerId: null,
    source: "manager",
    type: "ticket_discovered",
    summary: `${ticket.identifier} discovered`,
    createdAt: discoveredAt,
  });

  prs.forEach((pr, index) => {
    const runId = runs[index]?.id ?? null;
    pending.push({
      ticketId: ticket.id,
      runId,
      workerId: BACKFILL_WORKER_ID,
      source: "worker",
      type: "pr_opened",
      summary: `Opened PR #${pr.number}`,
      createdAt: isoToDate(pr.createdAt) ?? discoveredAt,
    });
  });

  for (const ci of ciRuns) {
    pending.push({
      ticketId: ticket.id,
      runId: ci.runId,
      workerId: null,
      source: "ci",
      type: "ci_started",
      summary: `CI started${ci.summary ? `: ${ci.summary}` : ""}`,
      createdAt: ci.createdAt,
    });
    if (ci.status !== "running" && ci.completedAt) {
      pending.push({
        ticketId: ticket.id,
        runId: ci.runId,
        workerId: null,
        source: "ci",
        type: ci.status === "passed" ? "ci_passed" : "ci_failed",
        summary: `CI ${ci.status}${ci.summary ? `: ${ci.summary}` : ""}`,
        createdAt: ci.completedAt,
      });
    }
  }

  const completedAt = isoToDate(ticket.completedAt);
  if (completedAt) {
    pending.push({
      ticketId: ticket.id,
      runId: runs.at(-1)?.id ?? null,
      workerId: null,
      source: "manager",
      type: "ticket_completed",
      summary: `${ticket.identifier} completed`,
      createdAt: completedAt,
    });
  } else if (ticket.status.type === "canceled") {
    const at = isoToDate(ticket.canceledAt) ?? isoToDate(ticket.updatedAt) ?? discoveredAt;
    pending.push({
      ticketId: ticket.id,
      runId: runs.at(-1)?.id ?? null,
      workerId: null,
      source: "manager",
      type: "ticket_abandoned",
      summary: `${ticket.identifier} abandoned`,
      createdAt: at,
    });
  }

  pending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return pending.map((event, index) => ({
    id: `ev_backfill_${ticket.id}_${index}`,
    ticketId: event.ticketId,
    runId: event.runId,
    workerId: event.workerId,
    source: event.source,
    type: event.type,
    summary: event.summary,
    payloadJson: null,
    createdAt: event.createdAt,
  }));
}
