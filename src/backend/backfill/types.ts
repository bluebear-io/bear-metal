import type { Ticket } from "../../shared/index.js";
import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";
import type {
  NewCiRun,
  NewEvent,
  NewPullRequest,
  NewRun,
  NewTicket,
} from "../db/types.js";

/**
 * Per-ticket bundle the backfill pipeline carries from "fetched from Linear+GitHub" to "written to
 * the dashboard DB". Each step in the pipeline owns one of these fields:
 *   loader → ticket
 *   github-source → prs, checkRunsByPrNumber
 *   mapper → rowBundle
 */
export interface FetchedTicket {
  ticket: Ticket;
  prs: PullRequest[];
  /** Keyed by `prKey(pr)` so the mapper can locate the right CI runs for each PR. */
  checkRunsByPrKey: Map<string, CheckRun[]>;
}

/** Row set produced by the mapper for a single ticket. The writer inserts these in FK-safe order. */
export interface RowBundle {
  ticket: NewTicket;
  runs: NewRun[];
  pullRequests: NewPullRequest[];
  ciRuns: NewCiRun[];
  events: NewEvent[];
}

/** Stable key for a PR across all our internal maps and synthetic IDs. */
export function prKey(pr: { owner: string; repo: string; number: number }): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}
