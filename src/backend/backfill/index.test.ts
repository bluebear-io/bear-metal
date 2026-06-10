import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import pino from "pino";
import type { Ticket } from "../../shared/index.js";
import type { CheckRun, PullRequest } from "../../shared/integrations/github/types.js";
import * as schema from "../db/schema.js";
import type { GitHubSource } from "./github-source.js";
import { parseArgs, runBackfill } from "./index.js";
import type { LinearSource } from "./linear-source.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";

const ticket = (id: string, statusType: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id,
  identifier: id.toUpperCase(),
  title: `Ticket ${id}`,
  description: null,
  url: `https://linear.app/${id}`,
  branchName: `feature/${id}`,
  status: { name: statusType, type: statusType },
  priority: 0,
  labels: ["bear-metal"],
  assignee: { id: "creator" },
  delegate: { id: "agent" },
  createdAt: T0,
  updatedAt: T1,
  completedAt: statusType === "completed" ? T1 : null,
  canceledAt: statusType === "canceled" ? T1 : null,
  ...overrides,
});

const pr = (owner: string, repo: string, number: number, head: string, merged: boolean): PullRequest => ({
  owner,
  repo,
  number,
  title: `PR ${number}`,
  headRef: head,
  state: merged ? "closed" : "open",
  draft: false,
  merged,
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
  createdAt: T0,
  updatedAt: T1,
  mergedAt: merged ? T1 : null,
  closedAt: merged ? T1 : null,
});

const successCheck: CheckRun = {
  id: 9001,
  name: "lint",
  status: "completed",
  conclusion: "success",
  url: null,
  summary: null,
  startedAt: T0,
  completedAt: T1,
};

let db: BetterSQLite3Database<typeof schema>;
let handle: import("../db/client.js").DbHandle;
const silent = pino({ level: "silent" });

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  handle = { dialect: "sqlite", db, schema, close: async () => undefined };
});

describe("parseArgs", () => {
  it("defaults to no flags", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null, verbose: false, sinceDays: null });
  });

  it("parses --since-days N", () => {
    expect(parseArgs(["--since-days", "7"])).toMatchObject({ sinceDays: 7 });
  });

  it("accepts --dry-run and --verbose", () => {
    expect(parseArgs(["--dry-run", "--verbose"])).toMatchObject({ dryRun: true, verbose: true });
  });

  it("parses --limit N", () => {
    expect(parseArgs(["--limit", "3"])).toMatchObject({ limit: 3 });
  });

  it("rejects --limit without a value", () => {
    expect(() => parseArgs(["--limit"])).toThrow(/--limit requires a number/);
  });

  it("rejects non-positive --limit", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--maybe"])).toThrow(/Unknown argument/);
  });
});

describe("runBackfill", () => {
  it("writes new tickets and skips ones already in the DB", async () => {
    const tickets = [
      ticket("lin_a", "completed"),
      ticket("lin_b", "canceled"),
      ticket("lin_c", "completed"),
    ];
    const linear: LinearSource = { findAllDelegatedTickets: vi.fn().mockResolvedValue(tickets) };
    const github: GitHubSource = {
      listInstallationRepositories: vi.fn().mockResolvedValue([{ owner: "acme", repo: "x" }]),
      listPullRequestsForBranch: vi.fn().mockImplementation(async (_o, _r, head) => {
        if (head === "feature/lin_a") return [pr("acme", "x", 1, "feature/lin_a", true)];
        if (head === "feature/lin_c") return [pr("acme", "x", 2, "feature/lin_c", true)];
        return [];
      }),
      listCheckRunsForRef: vi.fn().mockResolvedValue([successCheck]),
    };

    // Pre-seed lin_a so the second run treats it as existing.
    db.insert(schema.workers)
      .values({ id: "wk_existing", name: "old", status: "stopped", currentRunId: null, lastHeartbeatAt: null, startedAt: new Date(0), updatedAt: new Date(0) })
      .run();
    db.insert(schema.tickets)
      .values({
        id: "lin_a",
        identifier: "LIN_A",
        title: "preexisting",
        description: null,
        url: "",
        branchName: "",
        linearStatusName: "Done",
        linearStatusType: "completed",
        labelsJson: "[]",
        bmStatus: "completed",
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        completedAt: null,
      })
      .run();

    const summary = await runBackfill({
      linear,
      github,
      handle,
      agentId: "agent",
      options: { dryRun: false, limit: null, verbose: false, sinceDays: null },
      logger: silent,
    });

    expect(summary).toMatchObject({ fetched: 3, written: 2, skipped: 1, dryRun: false });
    expect(db.select().from(schema.tickets).all()).toHaveLength(3);
    // wk_backfill upserted; the pre-existing wk_existing should still be there.
    expect(db.select().from(schema.workers).all().map((w) => w.id).sort()).toEqual([
      "wk_backfill",
      "wk_existing",
    ]);
  });

  it("dry-run reads but does not write", async () => {
    const linear: LinearSource = { findAllDelegatedTickets: vi.fn().mockResolvedValue([ticket("lin_z", "completed")]) };
    const github: GitHubSource = {
      listInstallationRepositories: vi.fn().mockResolvedValue([{ owner: "acme", repo: "x" }]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([pr("acme", "x", 9, "feature/lin_z", true)]),
      listCheckRunsForRef: vi.fn().mockResolvedValue([]),
    };

    const summary = await runBackfill({
      linear,
      github,
      handle,
      agentId: "agent",
      options: { dryRun: true, limit: null, verbose: false, sinceDays: null },
      logger: silent,
    });

    expect(summary).toMatchObject({ written: 1, skipped: 0, dryRun: true });
    expect(db.select().from(schema.tickets).all()).toHaveLength(0);
    expect(db.select().from(schema.workers).all()).toHaveLength(0);
  });

  it("--limit caps the tickets processed", async () => {
    const tickets = [ticket("lin_1", "completed"), ticket("lin_2", "completed"), ticket("lin_3", "completed")];
    const linear: LinearSource = { findAllDelegatedTickets: vi.fn().mockResolvedValue(tickets) };
    const github: GitHubSource = {
      listInstallationRepositories: vi.fn().mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      listCheckRunsForRef: vi.fn().mockResolvedValue([]),
    };

    const summary = await runBackfill({
      linear,
      github,
      handle,
      agentId: "agent",
      options: { dryRun: false, limit: 2, verbose: false, sinceDays: null },
      logger: silent,
    });

    expect(summary.fetched).toBe(2);
    expect(summary.written).toBe(2);
  });
});
