import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { loadBackendConfig } from "../config.js";

type Db = BetterSQLite3Database<typeof schema>;
const t = (iso: string) => new Date(iso);

/** Wipe and repopulate the dashboard tables with a deterministic mock scenario. */
export function seedMockData(db: Db): void {
  // Delete in FK-safe order.
  db.delete(schema.events).run();
  db.delete(schema.ciChecks).run();
  db.delete(schema.ciRuns).run();
  db.delete(schema.reviewThreads).run();
  db.delete(schema.pullRequests).run();
  db.delete(schema.runs).run();
  db.delete(schema.tickets).run();
  db.delete(schema.workers).run();

  db.insert(schema.workers).values([
    { id: "wk_1", name: "worker-1", status: "busy", currentRunId: "run_in_1", lastHeartbeatAt: t("2026-06-09T09:00:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T09:00:00Z") },
    { id: "wk_2", name: "worker-2", status: "busy", currentRunId: "run_3", lastHeartbeatAt: t("2026-06-09T09:00:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T09:00:00Z") },
    { id: "wk_3", name: "worker-3", status: "dead", currentRunId: null, lastHeartbeatAt: t("2026-06-09T08:10:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T08:40:00Z") },
  ]).run();

  db.insert(schema.tickets).values([
    { id: "lin_1", identifier: "DEN-3001", title: "Add rate limiting to ingest API", description: "Throttle per-key.", url: "https://linear.app/bluebearsecurity/issue/DEN-3001", branchName: "feature/den-3001-rate-limit", linearStatusName: "Done", linearStatusType: "completed", labelsJson: JSON.stringify(["bear-metal", "module:bff"]), bmStatus: "completed", attemptCount: 1, maxAttempts: 5, createdAt: t("2026-06-09T07:05:00Z"), updatedAt: t("2026-06-09T07:55:00Z"), completedAt: t("2026-06-09T07:55:00Z") }, // happy path: completed & merged
    { id: "lin_2", identifier: "DEN-3002", title: "Fix flaky session aggregator test", description: "Race in fixture.", url: "https://linear.app/bluebearsecurity/issue/DEN-3002", branchName: "feature/den-3002-flaky-test", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal"]), bmStatus: "ci_failed", attemptCount: 2, maxAttempts: 5, createdAt: t("2026-06-09T08:00:00Z"), updatedAt: t("2026-06-09T08:50:00Z"), completedAt: null }, // last CI failed; retry (attempt 2) in flight
    { id: "lin_3", identifier: "DEN-3003", title: "Migrate detector config to v3", description: "Schema change.", url: "https://linear.app/bluebearsecurity/issue/DEN-3003", branchName: "feature/den-3003-config-v3", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal", "module:ingest"]), bmStatus: "abandoned", attemptCount: 5, maxAttempts: 5, createdAt: t("2026-06-08T20:00:00Z"), updatedAt: t("2026-06-09T06:00:00Z"), completedAt: null }, // exhausted max_attempts → abandoned
    { id: "lin_4", identifier: "DEN-3004", title: "Add CSV export to reports page", description: "Client-side export.", url: "https://linear.app/bluebearsecurity/issue/DEN-3004", branchName: "feature/den-3004-csv-export", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal", "module:bff"]), bmStatus: "in_progress", attemptCount: 1, maxAttempts: 5, createdAt: t("2026-06-09T08:55:00Z"), updatedAt: t("2026-06-09T09:00:00Z"), completedAt: null }, // fresh, in progress on a busy worker
  ]).run();

  db.insert(schema.runs).values([
    { id: "run_1", ticketId: "lin_1", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded", contextJson: null, startedAt: t("2026-06-09T07:05:00Z"), endedAt: t("2026-06-09T07:50:00Z"), stopReason: "completed", error: null, promptTokens: 320_000, completionTokens: 18_000, modelName: "claude-sonnet-4", provider: "anthropic", createdAt: t("2026-06-09T07:05:00Z") },
    { id: "run_2", ticketId: "lin_2", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded", contextJson: null, startedAt: t("2026-06-09T08:00:00Z"), endedAt: t("2026-06-09T08:20:00Z"), stopReason: "completed", error: null, promptTokens: 210_000, completionTokens: 12_500, modelName: "gpt-5", provider: "openai", createdAt: t("2026-06-09T08:00:00Z") },
    { id: "run_3", ticketId: "lin_2", attemptNumber: 2, workerId: "wk_2", trigger: "ci_failure", status: "running", contextJson: JSON.stringify({ branch: "feature/den-3002-flaky-test", note: "CI failed: 1 test" }), startedAt: t("2026-06-09T08:45:00Z"), endedAt: null, stopReason: null, error: null, promptTokens: null, completionTokens: null, modelName: null, provider: null, createdAt: t("2026-06-09T08:45:00Z") },
    { id: "run_to_3", ticketId: "lin_3", attemptNumber: 5, workerId: "wk_3", trigger: "delegated_back", status: "timed_out", contextJson: null, startedAt: t("2026-06-09T05:30:00Z"), endedAt: t("2026-06-09T06:00:00Z"), stopReason: "timeout", error: "exceeded 30m wall clock", promptTokens: 450_000, completionTokens: 22_000, modelName: "gemini-2.5-pro", provider: "google", createdAt: t("2026-06-09T05:30:00Z") },
    { id: "run_in_1", ticketId: "lin_4", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "running", contextJson: null, startedAt: t("2026-06-09T08:55:00Z"), endedAt: null, stopReason: null, error: null, promptTokens: null, completionTokens: null, modelName: null, provider: null, createdAt: t("2026-06-09T08:55:00Z") },
  ]).run();

  db.insert(schema.pullRequests).values([
    { id: "pr_1", ticketId: "lin_1", number: 1500, title: "Add rate limiting to ingest API", headRef: "feature/den-3001-rate-limit", state: "closed", draft: false, merged: true, url: "https://github.com/bluebear-io/blueden/pull/1500", lastRunId: "run_1", createdAt: t("2026-06-09T07:40:00Z"), updatedAt: t("2026-06-09T07:55:00Z") },
    { id: "pr_2", ticketId: "lin_2", number: 1501, title: "Fix flaky session aggregator test", headRef: "feature/den-3002-flaky-test", state: "open", draft: false, merged: false, url: "https://github.com/bluebear-io/blueden/pull/1501", lastRunId: "run_3", createdAt: t("2026-06-09T08:18:00Z"), updatedAt: t("2026-06-09T08:46:00Z") },
  ]).run();

  db.insert(schema.ciRuns).values([
    { id: "ci_1", ticketId: "lin_1", runId: "run_1", prId: "pr_1", status: "passed", url: "https://github.com/bluebear-io/blueden/actions/runs/1", summary: null, createdAt: t("2026-06-09T07:45:00Z"), completedAt: t("2026-06-09T07:52:00Z") },
    { id: "ci_2", ticketId: "lin_2", runId: "run_2", prId: "pr_2", status: "failed", url: "https://github.com/bluebear-io/blueden/actions/runs/2", summary: "2 failing: ESLint, session_aggregator.test", createdAt: t("2026-06-09T08:25:00Z"), completedAt: t("2026-06-09T08:40:00Z") },
  ]).run();

  db.insert(schema.ciChecks).values([
    { id: "chk_1", ciRunId: "ci_2", source: "check_run", externalId: "9001", name: "ESLint", conclusion: "failure", detailsUrl: "https://github.com/bluebear-io/blueden/actions/runs/2/job/9001", summary: "1 problem detected", annotationsJson: JSON.stringify([{ path: "src/manager/scheduler.ts", start_line: 122, message: "'reporter' is defined but never used.", annotation_level: "warning" }]), createdAt: t("2026-06-09T08:30:00Z") },
    { id: "chk_2", ciRunId: "ci_2", source: "check_run", externalId: "9002", name: "unit tests", conclusion: "failure", detailsUrl: "https://github.com/bluebear-io/blueden/actions/runs/2/job/9002", summary: "session_aggregator.test failed", annotationsJson: JSON.stringify([{ path: "tests/session_aggregator.test.ts", start_line: 48, message: "Expected 3 events, got 2", annotation_level: "failure" }]), createdAt: t("2026-06-09T08:32:00Z") },
  ]).run();

  db.insert(schema.reviewThreads).values([
    {
      id: "thr_1", prId: "pr_2", path: "src/manager/scheduler.ts", line: 211, isResolved: false,
      commentsJson: JSON.stringify([
        { id: "cmt_1", body: "Should this guard against `null` PR?", author: "reviewer-a", url: "https://github.com/bluebear-io/blueden/pull/1501#discussion_r1", createdAt: "2026-06-09T08:33:00Z", updatedAt: "2026-06-09T08:33:00Z", path: "src/manager/scheduler.ts", line: 211 },
      ]),
      createdAt: t("2026-06-09T08:33:00Z"), updatedAt: t("2026-06-09T08:33:00Z"),
    },
    {
      id: "thr_2", prId: "pr_2", path: "tests/session_aggregator.test.ts", line: 48, isResolved: true,
      commentsJson: JSON.stringify([
        { id: "cmt_2", body: "nit: add a comment describing the fixture.", author: "reviewer-b", url: "https://github.com/bluebear-io/blueden/pull/1501#discussion_r2", createdAt: "2026-06-09T08:34:00Z", updatedAt: "2026-06-09T08:34:00Z", path: "tests/session_aggregator.test.ts", line: 48 },
        { id: "cmt_3", body: "Done in next push.", author: "bear-metal", url: "https://github.com/bluebear-io/blueden/pull/1501#discussion_r3", createdAt: "2026-06-09T08:36:00Z", updatedAt: "2026-06-09T08:36:00Z", path: "tests/session_aggregator.test.ts", line: 48 },
      ]),
      createdAt: t("2026-06-09T08:34:00Z"), updatedAt: t("2026-06-09T08:36:00Z"),
    },
  ]).run();

  db.insert(schema.events).values([
    { id: "ev_1", ticketId: "lin_1", runId: "run_1", workerId: "wk_1", source: "manager", type: "dispatched", summary: "Dispatched DEN-3001 to worker-1", payloadJson: null, createdAt: t("2026-06-09T07:05:00Z") },
    { id: "ev_2", ticketId: "lin_1", runId: "run_1", workerId: "wk_1", source: "worker", type: "pr_opened", summary: "Opened PR #1500", payloadJson: null, createdAt: t("2026-06-09T07:40:00Z") },
    { id: "ev_3", ticketId: "lin_1", runId: "run_1", workerId: null, source: "ci", type: "ci_passed", summary: "CI passed", payloadJson: null, createdAt: t("2026-06-09T07:52:00Z") },
    { id: "ev_4", ticketId: "lin_1", runId: "run_1", workerId: null, source: "manager", type: "ticket_completed", summary: "DEN-3001 completed", payloadJson: null, createdAt: t("2026-06-09T07:55:00Z") },
    { id: "ev_5", ticketId: "lin_2", runId: "run_2", workerId: null, source: "ci", type: "ci_failed", summary: "CI failed: 1 test", payloadJson: null, createdAt: t("2026-06-09T08:40:00Z") },
    { id: "ev_6", ticketId: "lin_2", runId: "run_3", workerId: "wk_2", source: "manager", type: "delegated_back", summary: "Re-dispatched DEN-3002 to worker-2", payloadJson: null, createdAt: t("2026-06-09T08:45:00Z") },
    { id: "ev_7", ticketId: "lin_3", runId: "run_to_3", workerId: "wk_3", source: "manager", type: "worker_timeout", summary: "Stopped worker-3 after 30m", payloadJson: null, createdAt: t("2026-06-09T06:00:00Z") },
    { id: "ev_8", ticketId: "lin_3", runId: null, workerId: null, source: "manager", type: "ticket_abandoned", summary: "DEN-3003 abandoned after 5 attempts", payloadJson: null, createdAt: t("2026-06-09T06:00:00Z") },
  ]).run();
}

/** CLI entry: open (or create) the configured DB file, migrate, seed. */
function main(): void {
  const { dbPath } = loadBackendConfig();
  const created = !existsSync(dbPath);
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
  sqlite.close();
  console.log(`${created ? "Created" : "Reseeded"} mock DB at ${dbPath}`);
}

// Run when invoked directly (tsx src/backend/mock/seed.ts).
const invokedPath = process.argv[1];
if (invokedPath && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)) {
  main();
}
