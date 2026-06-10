import type { Ticket } from "../db/types.js";

/** A PR plus its derived overall CI status, distilled down to what `deriveBmStatus` needs. */
export interface BmStatusPrInput {
  merged: boolean;
  state: "open" | "closed";
  /** Latest CI conclusion across all check runs for this PR — `null` when there are no check runs yet. */
  latestCiStatus: "running" | "passed" | "failed" | null;
}

export interface BmStatusInput {
  /** Linear workflow-state type — e.g. `"unstarted"`, `"started"`, `"completed"`, `"canceled"`. */
  linearStatusType: string;
  /** PRs found for this ticket. Callers may pass them in any order; the function picks deterministically. */
  prs: BmStatusPrInput[];
}

/**
 * Map historical Linear+GitHub state to a single dashboard `bmStatus`. The dashboard's `bmStatus`
 * enum is the union of every state the manager can drive a ticket into; backfill only ever lands on
 * a subset of those because we infer from outcomes, not from live transitions.
 *
 * Precedence (highest first):
 *   1. any PR merged                  → completed
 *   2. open PR + CI failed            → ci_failed
 *   3. open PR + CI running           → ci_running
 *   4. open PR + CI passed or no CI   → pr_open
 *   5. closed-unmerged PR (none merged anywhere) → abandoned
 *   6. no PR + Linear canceled        → abandoned
 *   7. no PR + Linear started         → in_progress
 *   8. no PR + everything else        → discovered
 */
export function deriveBmStatus(input: BmStatusInput): Ticket["bmStatus"] {
  if (input.prs.some((pr) => pr.merged)) {
    return "completed";
  }

  const openPr = input.prs.find((pr) => pr.state === "open");
  if (openPr) {
    if (openPr.latestCiStatus === "failed") {
      return "ci_failed";
    }
    if (openPr.latestCiStatus === "running") {
      return "ci_running";
    }
    return "pr_open";
  }

  if (input.prs.length > 0) {
    return "abandoned";
  }

  if (input.linearStatusType === "canceled") {
    return "abandoned";
  }
  if (input.linearStatusType === "started") {
    return "in_progress";
  }
  return "discovered";
}
