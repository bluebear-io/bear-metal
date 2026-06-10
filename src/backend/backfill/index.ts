import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createLogger, type Logger } from "../../shared/index.js";
import { GitHubIntegration, LinearIntegration } from "../../shared/index.js";
import { loadBackendConfig } from "../config.js";
import * as schema from "../db/schema.js";
import { loadDelegatedTickets, type LinearSource } from "./linear-source.js";
import { type GitHubSource, loadCheckRunsForPullRequest, loadPullRequestsForBranch } from "./github-source.js";
import { mapTicketBundle } from "./mapper.js";
import { prKey } from "./types.js";
import { ensureBackfillWorker, writeBundle } from "./writer.js";

export interface BackfillOptions {
  dryRun: boolean;
  limit: number | null;
  verbose: boolean;
}

export interface BackfillSummary {
  fetched: number;
  written: number;
  skipped: number;
  dryRun: boolean;
}

export interface BackfillDeps {
  linear: LinearSource;
  github: GitHubSource;
  db: BetterSQLite3Database<typeof schema>;
  agentId: string;
  options: BackfillOptions;
  logger: Logger;
  now?: Date;
}

/**
 * Orchestrate the backfill: load every delegated Linear ticket, enrich each with GitHub PRs
 * + check runs, map to a row bundle, and write it to the dashboard DB unless --dry-run.
 *
 * Returns a summary the CLI prints; callers writing automated tests can also assert on it.
 */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const { linear, github, db, agentId, options, logger } = deps;
  const now = deps.now ?? new Date();

  if (!options.dryRun) {
    ensureBackfillWorker(db, now);
  }

  const tickets = await loadDelegatedTickets(linear, {
    agentId,
    limit: options.limit ?? undefined,
  });
  const repos = await github.listInstallationRepositories();
  logger.debug({ ticketCount: tickets.length, repoCount: repos.length }, "backfill: load complete");

  let written = 0;
  let skipped = 0;

  for (const ticket of tickets) {
    const prs = await loadPullRequestsForBranch(github, repos, ticket.branchName);
    const checkRunsByPrKey = new Map<string, Awaited<ReturnType<typeof loadCheckRunsForPullRequest>>>();
    for (const pr of prs) {
      checkRunsByPrKey.set(prKey(pr), await loadCheckRunsForPullRequest(github, pr));
    }
    const bundle = mapTicketBundle({ ticket, prs, checkRunsByPrKey });

    if (options.dryRun) {
      written += 1;
      if (options.verbose) {
        logger.info(
          {
            ticket: ticket.identifier,
            bmStatus: bundle.ticket.bmStatus,
            prs: bundle.pullRequests.length,
            ciRuns: bundle.ciRuns.length,
            events: bundle.events.length,
          },
          "backfill: would write",
        );
      }
      continue;
    }

    const result = writeBundle(db, bundle);
    if (result.written) {
      written += 1;
      if (options.verbose) {
        logger.info(
          { ticket: ticket.identifier, bmStatus: bundle.ticket.bmStatus, prs: bundle.pullRequests.length },
          "backfill: wrote ticket",
        );
      }
    } else {
      skipped += 1;
      if (options.verbose) {
        logger.info({ ticket: ticket.identifier }, "backfill: ticket already in DB, skipped");
      }
    }
  }

  return { fetched: tickets.length, written, skipped, dryRun: options.dryRun };
}

/** Parse a vanilla `process.argv.slice(2)` into our flag set. Unknown flags are rejected loudly. */
export function parseArgs(argv: string[]): BackfillOptions {
  const options: BackfillOptions = { dryRun: false, limit: null, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--limit") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--limit requires a number");
      const value = Number(next);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit must be a positive integer, got: ${next}`);
      }
      options.limit = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredPositiveIntEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const backendConfig = loadBackendConfig();
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? "info", name: "bear-metal-backfill" });

  const linear = new LinearIntegration({ token: requiredEnv("LINEAR_API_TOKEN") });
  const github = new GitHubIntegration({
    appId: requiredPositiveIntEnv("GITHUB_APP_ID"),
    privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    installationId: requiredPositiveIntEnv("GITHUB_APP_INSTALLATION_ID"),
  });
  const agentId = requiredEnv("LINEAR_ASSIGNEE_ID");

  const sqlite = new Database(backendConfig.dbPath);
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });

  try {
    const summary = await runBackfill({ linear, github, db, agentId, options, logger });
    logger.info(
      { fetched: summary.fetched, written: summary.written, skipped: summary.skipped, dryRun: summary.dryRun },
      summary.dryRun
        ? `Dry run — would backfill ${summary.written} tickets`
        : `Backfilled ${summary.written} tickets, skipped ${summary.skipped} existing tickets`,
    );
  } finally {
    sqlite.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
