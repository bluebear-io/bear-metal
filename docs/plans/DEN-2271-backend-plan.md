# Bear Metal Dashboard — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only backend for the bear-metal observability dashboard — a SQLite schema (Drizzle), a mock-data seeder, and an Express API exposing tickets, ticket detail, and workers.

**Architecture:** A new `src/backend/` folder inside the existing single root package. Drizzle ORM over `better-sqlite3` defines six tables mirroring the existing `src/shared` domain types. The Express app reads the DB **read-only** (fail-fast if missing). A seeder writes a realistic mock scenario for the UI to consume. The manager will later write real data to the same schema.

**Tech Stack:** TypeScript (ESM/NodeNext), Express 4, Drizzle ORM, better-sqlite3, pino, Vitest, supertest.

**Spec:** [docs/plans/DEN-2271.md](DEN-2271.md)

---

## File Structure

- `src/backend/db/schema.ts` — Drizzle table definitions (the contract).
- `src/backend/db/types.ts` — inferred row types + status string unions.
- `src/backend/db/client.ts` — read-only DB client factory (fail-fast).
- `src/backend/db/repository.ts` — query functions consumed by routes.
- `src/backend/mock/seed.ts` — writable seeder + realistic scenario; CLI-runnable.
- `src/backend/routes/index.ts` — Express router (health, tickets, workers).
- `src/backend/middleware/auth.ts` — no-op auth seam.
- `src/backend/app.ts` — `createApp(db)` factory (DB injected for testability).
- `src/backend/index.ts` — entrypoint: load config, open DB, listen.
- `src/backend/config.ts` — backend env config (DB path, port).
- `drizzle.config.ts` — drizzle-kit config (repo root).
- `src/backend/db/migrations/*` — generated SQL migrations.
- Tests: `src/backend/db/schema.test.ts`, `src/backend/mock/seed.test.ts`, `src/backend/db/repository.test.ts`, `src/backend/routes/api.test.ts`.

---

## Task 0: Dependencies and scaffolding

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `drizzle.config.ts`
- Create: `.env.example` (append)

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install drizzle-orm@0.44.6 better-sqlite3@12.4.1
npm install -D drizzle-kit@0.31.5 @types/better-sqlite3@7.6.13 supertest@7.1.4 @types/supertest@6.0.3
```
(Pin to the exact versions resolved; per CONTRIBUTING the lockfile must capture exact versions.)

- [ ] **Step 2: Add npm scripts to `package.json`**

Add to `"scripts"`:
```json
"dev:backend": "tsx watch src/backend/index.ts",
"start:backend": "node dist/backend/index.js",
"seed:mock": "tsx src/backend/mock/seed.ts",
"db:generate": "drizzle-kit generate"
```

- [ ] **Step 3: Exclude the UI app from the root tsc build**

Edit `tsconfig.json` — add an `exclude` key so the manager build never compiles browser code:
```json
{
  "compilerOptions": { "...": "unchanged" },
  "include": ["src"],
  "exclude": ["src/ui", "dist", "node_modules"]
}
```

- [ ] **Step 4: Create `drizzle.config.ts` at repo root**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/backend/db/schema.ts",
  out: "./src/backend/db/migrations",
});
```

- [ ] **Step 5: Document the DB path env var**

Append to `.env.example`:
```
# Bear Metal dashboard backend
BEAR_METAL_DB_PATH=./bear-metal.db
BACKEND_PORT=3100
```

- [ ] **Step 6: Verify install + typecheck still pass**

Run: `npm run typecheck`
Expected: PASS (no `src/backend` files yet; build is unaffected).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json drizzle.config.ts .env.example
git commit -m "chore(backend): [DEN-2271] add backend deps, scripts, drizzle config"
```

---

## Task 1: Drizzle schema

**Files:**
- Create: `src/backend/db/schema.ts`
- Test: `src/backend/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

`src/backend/db/schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";

describe("schema", () => {
  it("exports all six tables", () => {
    expect(Object.keys(schema).sort()).toEqual(
      ["ciRuns", "events", "pullRequests", "runs", "tickets", "workers"].sort(),
    );
  });

  it("can be created in a SQLite database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    // push schema via drizzle-kit-equivalent raw DDL is covered by migrations;
    // here we assert the table objects expose their SQL names.
    db.run(sql`CREATE TABLE tickets (id TEXT PRIMARY KEY)`);
    const rows = db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    expect(rows).toContainEqual({ name: "tickets" });
    sqlite.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/db/schema.test.ts`
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 3: Write `src/backend/db/schema.ts`**

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  url: text("url").notNull(),
  branchName: text("branch_name").notNull(),
  linearStatusName: text("linear_status_name").notNull(),
  linearStatusType: text("linear_status_type").notNull(),
  labelsJson: text("labels_json").notNull().default("[]"),
  bmStatus: text("bm_status", {
    enum: ["discovered", "dispatched", "in_progress", "pr_open", "ci_running", "ci_failed", "completed", "abandoned"],
  }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  completedAt: ts("completed_at"),
});

export const workers = sqliteTable("workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["idle", "busy", "stopped", "dead"] }).notNull(),
  currentRunId: text("current_run_id"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  startedAt: ts("started_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  attemptNumber: integer("attempt_number").notNull(),
  workerId: text("worker_id").references(() => workers.id),
  trigger: text("trigger", { enum: ["new", "ci_failure", "delegated_back"] }).notNull(),
  status: text("status", {
    enum: ["dispatched", "running", "succeeded", "failed", "timed_out", "crashed"],
  }).notNull(),
  contextJson: text("context_json"),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  stopReason: text("stop_reason", { enum: ["completed", "timeout", "crash", "error"] }),
  error: text("error"),
  createdAt: ts("created_at").notNull(),
});

export const pullRequests = sqliteTable("pull_requests", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  headRef: text("head_ref").notNull(),
  state: text("state", { enum: ["open", "closed"] }).notNull(),
  draft: integer("draft", { mode: "boolean" }).notNull(),
  merged: integer("merged", { mode: "boolean" }).notNull(),
  url: text("url").notNull(),
  lastRunId: text("last_run_id").references(() => runs.id),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const ciRuns = sqliteTable("ci_runs", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  runId: text("run_id").notNull().references(() => runs.id),
  prId: text("pr_id").references(() => pullRequests.id),
  status: text("status", { enum: ["running", "passed", "failed"] }).notNull(),
  url: text("url"),
  summary: text("summary"),
  createdAt: ts("created_at").notNull(),
  completedAt: ts("completed_at"),
});

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id").references(() => tickets.id),
  runId: text("run_id").references(() => runs.id),
  workerId: text("worker_id").references(() => workers.id),
  source: text("source", { enum: ["manager", "worker", "ci"] }).notNull(),
  type: text("type", {
    enum: ["ticket_discovered", "dispatched", "branch_created", "progress", "pr_opened", "ci_started", "ci_passed", "ci_failed", "delegated_back", "worker_timeout", "worker_crashed", "ticket_completed", "ticket_abandoned"],
  }).notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json"),
  createdAt: ts("created_at").notNull(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/db/schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a `0000_*.sql` file appears under `src/backend/db/migrations/` containing `CREATE TABLE` for all six tables.

- [ ] **Step 6: Commit**

```bash
git add src/backend/db/schema.ts src/backend/db/schema.test.ts src/backend/db/migrations
git commit -m "feat(backend): [DEN-2271] add drizzle schema and initial migration"
```

---

## Task 2: Inferred row types

**Files:**
- Create: `src/backend/db/types.ts`
- Test: `src/backend/db/types.test.ts`

- [ ] **Step 1: Write the failing test** (a compile-time + trivial runtime assertion)

`src/backend/db/types.test.ts`:
```ts
import { describe, it, expectTypeOf } from "vitest";
import type { Ticket, Worker, Run, PullRequestRow, CiRun, EventRow } from "./types.js";

describe("row types", () => {
  it("Ticket has the expected key fields", () => {
    expectTypeOf<Ticket>().toHaveProperty("identifier");
    expectTypeOf<Ticket>().toHaveProperty("bmStatus");
    expectTypeOf<Worker>().toHaveProperty("status");
    expectTypeOf<Run>().toHaveProperty("attemptNumber");
    expectTypeOf<PullRequestRow>().toHaveProperty("headRef");
    expectTypeOf<CiRun>().toHaveProperty("status");
    expectTypeOf<EventRow>().toHaveProperty("type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/db/types.test.ts`
Expected: FAIL — `Cannot find module './types.js'`.

- [ ] **Step 3: Write `src/backend/db/types.ts`**

```ts
import type { tickets, workers, runs, pullRequests, ciRuns, events } from "./schema.js";

export type Ticket = typeof tickets.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type CiRun = typeof ciRuns.$inferSelect;
export type EventRow = typeof events.$inferSelect;

export type NewTicket = typeof tickets.$inferInsert;
export type NewWorker = typeof workers.$inferInsert;
export type NewRun = typeof runs.$inferInsert;
export type NewPullRequest = typeof pullRequests.$inferInsert;
export type NewCiRun = typeof ciRuns.$inferInsert;
export type NewEvent = typeof events.$inferInsert;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/db/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/types.ts src/backend/db/types.test.ts
git commit -m "feat(backend): [DEN-2271] add inferred drizzle row types"
```

---

## Task 3: Read-only DB client (fail-fast)

**Files:**
- Create: `src/backend/db/client.ts`
- Test: `src/backend/db/client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/backend/db/client.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openReadOnlyDb } from "./client.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("openReadOnlyDb", () => {
  it("throws a clear error when the DB file is missing (fail-fast)", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-"));
    expect(() => openReadOnlyDb(join(dir, "nope.db"))).toThrow(/database file not found/i);
  });

  it("opens an existing DB read-only and rejects writes", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-"));
    const path = join(dir, "ok.db");
    const seed = new Database(path);
    seed.exec("CREATE TABLE t (id TEXT)");
    seed.close();

    const { sqlite } = openReadOnlyDb(path);
    expect(() => sqlite.exec("INSERT INTO t VALUES ('x')")).toThrow();
    sqlite.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/db/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Write `src/backend/db/client.ts`**

```ts
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export interface ReadOnlyDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

/**
 * Opens the agent's SQLite file read-only. Fails fast (per repo policy): a missing
 * file is a configuration error, never silently created or substituted.
 */
export function openReadOnlyDb(path: string): ReadOnlyDb {
  if (!existsSync(path)) {
    throw new Error(`Bear Metal database file not found at "${path}"`);
  }
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/db/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/client.ts src/backend/db/client.test.ts
git commit -m "feat(backend): [DEN-2271] add fail-fast read-only sqlite client"
```

---

## Task 4: Mock-data seeder

**Files:**
- Create: `src/backend/mock/seed.ts`
- Test: `src/backend/mock/seed.test.ts`

The seeder exposes `seedMockData(db)` (pure, testable) and a CLI wrapper that opens a
writable DB at `BEAR_METAL_DB_PATH`, runs migrations, and seeds. The scenario must cover:
a completed ticket, a ticket mid-CI-failure retry (2 attempts), an abandoned ticket
(hit max_attempts), an in-progress ticket on a busy worker, and a dead/timed-out worker.

- [ ] **Step 1: Write the failing test**

`src/backend/mock/seed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { seedMockData } from "./seed.js";

function freshDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  return db;
}

describe("seedMockData", () => {
  it("inserts a realistic multi-scenario dataset", () => {
    const db = freshDb();
    seedMockData(db);

    expect(db.select().from(schema.tickets).all().length).toBeGreaterThanOrEqual(4);
    expect(db.select().from(schema.workers).all().length).toBeGreaterThanOrEqual(3);

    const ts = db.select().from(schema.tickets).all();
    expect(ts.some((t) => t.bmStatus === "completed")).toBe(true);
    expect(ts.some((t) => t.bmStatus === "abandoned" && t.attemptCount === t.maxAttempts)).toBe(true);

    // a ticket with >1 attempt and a ci_failure-triggered retry
    const runs = db.select().from(schema.runs).all();
    expect(runs.some((r) => r.attemptNumber >= 2 && r.trigger === "ci_failure")).toBe(true);

    // a dead worker and a timed_out run exist
    expect(db.select().from(schema.workers).all().some((w) => w.status === "dead")).toBe(true);
    expect(runs.some((r) => r.status === "timed_out")).toBe(true);
  });

  it("is idempotent: clears and reseeds without unique-constraint errors", () => {
    const db = freshDb();
    seedMockData(db);
    expect(() => seedMockData(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/mock/seed.test.ts`
Expected: FAIL — `Cannot find module './seed.js'`.

- [ ] **Step 3: Write `src/backend/mock/seed.ts`**

```ts
import { existsSync } from "node:fs";
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
  db.delete(schema.ciRuns).run();
  db.delete(schema.pullRequests).run();
  db.delete(schema.runs).run();
  db.delete(schema.tickets).run();
  db.delete(schema.workers).run();

  db.insert(schema.workers).values([
    { id: "wk_1", name: "worker-1", status: "busy", currentRunId: "run_in_1", lastHeartbeatAt: t("2026-06-09T09:00:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T09:00:00Z") },
    { id: "wk_2", name: "worker-2", status: "idle", currentRunId: null, lastHeartbeatAt: t("2026-06-09T09:00:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T09:00:00Z") },
    { id: "wk_3", name: "worker-3", status: "dead", currentRunId: null, lastHeartbeatAt: t("2026-06-09T08:10:00Z"), startedAt: t("2026-06-09T07:00:00Z"), updatedAt: t("2026-06-09T08:40:00Z") },
  ]).run();

  db.insert(schema.tickets).values([
    { id: "lin_1", identifier: "DEN-3001", title: "Add rate limiting to ingest API", description: "Throttle per-key.", url: "https://linear.app/bluebearsecurity/issue/DEN-3001", branchName: "feature/den-3001-rate-limit", linearStatusName: "Done", linearStatusType: "completed", labelsJson: JSON.stringify(["bear-metal", "module:bff"]), bmStatus: "completed", attemptCount: 1, maxAttempts: 5, createdAt: t("2026-06-09T07:05:00Z"), updatedAt: t("2026-06-09T07:55:00Z"), completedAt: t("2026-06-09T07:55:00Z") },
    { id: "lin_2", identifier: "DEN-3002", title: "Fix flaky session aggregator test", description: "Race in fixture.", url: "https://linear.app/bluebearsecurity/issue/DEN-3002", branchName: "feature/den-3002-flaky-test", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal"]), bmStatus: "ci_failed", attemptCount: 2, maxAttempts: 5, createdAt: t("2026-06-09T08:00:00Z"), updatedAt: t("2026-06-09T08:50:00Z"), completedAt: null },
    { id: "lin_3", identifier: "DEN-3003", title: "Migrate detector config to v3", description: "Schema change.", url: "https://linear.app/bluebearsecurity/issue/DEN-3003", branchName: "feature/den-3003-config-v3", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal", "module:ingest"]), bmStatus: "abandoned", attemptCount: 5, maxAttempts: 5, createdAt: t("2026-06-08T20:00:00Z"), updatedAt: t("2026-06-09T06:00:00Z"), completedAt: null },
    { id: "lin_4", identifier: "DEN-3004", title: "Add CSV export to reports page", description: "Client-side export.", url: "https://linear.app/bluebearsecurity/issue/DEN-3004", branchName: "feature/den-3004-csv-export", linearStatusName: "In Progress", linearStatusType: "started", labelsJson: JSON.stringify(["bear-metal", "module:bff"]), bmStatus: "in_progress", attemptCount: 1, maxAttempts: 5, createdAt: t("2026-06-09T08:55:00Z"), updatedAt: t("2026-06-09T09:00:00Z"), completedAt: null },
  ]).run();

  db.insert(schema.runs).values([
    { id: "run_1", ticketId: "lin_1", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded", contextJson: null, startedAt: t("2026-06-09T07:05:00Z"), endedAt: t("2026-06-09T07:50:00Z"), stopReason: "completed", error: null, createdAt: t("2026-06-09T07:05:00Z") },
    { id: "run_2", ticketId: "lin_2", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded", contextJson: null, startedAt: t("2026-06-09T08:00:00Z"), endedAt: t("2026-06-09T08:20:00Z"), stopReason: "completed", error: null, createdAt: t("2026-06-09T08:00:00Z") },
    { id: "run_3", ticketId: "lin_2", attemptNumber: 2, workerId: "wk_2", trigger: "ci_failure", status: "running", contextJson: JSON.stringify({ branch: "feature/den-3002-flaky-test", note: "CI failed: 1 test" }), startedAt: t("2026-06-09T08:45:00Z"), endedAt: null, stopReason: null, error: null, createdAt: t("2026-06-09T08:45:00Z") },
    { id: "run_to_3", ticketId: "lin_3", attemptNumber: 5, workerId: "wk_3", trigger: "delegated_back", status: "timed_out", contextJson: null, startedAt: t("2026-06-09T05:30:00Z"), endedAt: t("2026-06-09T06:00:00Z"), stopReason: "timeout", error: "exceeded 30m wall clock", createdAt: t("2026-06-09T05:30:00Z") },
    { id: "run_in_1", ticketId: "lin_4", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "running", contextJson: null, startedAt: t("2026-06-09T08:55:00Z"), endedAt: null, stopReason: null, error: null, createdAt: t("2026-06-09T08:55:00Z") },
  ]).run();

  db.insert(schema.pullRequests).values([
    { id: "pr_1", ticketId: "lin_1", number: 1500, title: "Add rate limiting to ingest API", headRef: "feature/den-3001-rate-limit", state: "closed", draft: false, merged: true, url: "https://github.com/bluebear-io/blueden/pull/1500", lastRunId: "run_1", createdAt: t("2026-06-09T07:40:00Z"), updatedAt: t("2026-06-09T07:55:00Z") },
    { id: "pr_2", ticketId: "lin_2", number: 1501, title: "Fix flaky session aggregator test", headRef: "feature/den-3002-flaky-test", state: "open", draft: false, merged: false, url: "https://github.com/bluebear-io/blueden/pull/1501", lastRunId: "run_3", createdAt: t("2026-06-09T08:18:00Z"), updatedAt: t("2026-06-09T08:46:00Z") },
  ]).run();

  db.insert(schema.ciRuns).values([
    { id: "ci_1", ticketId: "lin_1", runId: "run_1", prId: "pr_1", status: "passed", url: "https://github.com/bluebear-io/blueden/actions/runs/1", summary: null, createdAt: t("2026-06-09T07:45:00Z"), completedAt: t("2026-06-09T07:52:00Z") },
    { id: "ci_2", ticketId: "lin_2", runId: "run_2", prId: "pr_2", status: "failed", url: "https://github.com/bluebear-io/blueden/actions/runs/2", summary: "1 failing: session_aggregator.test", createdAt: t("2026-06-09T08:25:00Z"), completedAt: t("2026-06-09T08:40:00Z") },
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/mock/seed.test.ts`
Expected: PASS (both tests). (Task 5 creates `config.ts`; if running this task alone, the `main()` import is only exercised by the CLI, not the tests — but add `config.ts` from Task 5 Step 3 first if typecheck complains.)

- [ ] **Step 5: Smoke-test the CLI**

Run: `BEAR_METAL_DB_PATH=./tmp-seed.db npm run seed:mock && rm ./tmp-seed.db`
Expected: prints `Created mock DB at ./tmp-seed.db`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/mock/seed.ts src/backend/mock/seed.test.ts
git commit -m "feat(backend): [DEN-2271] add mock-data seeder with realistic scenario"
```

---

## Task 5: Backend config

**Files:**
- Create: `src/backend/config.ts`
- Test: `src/backend/config.test.ts`

- [ ] **Step 1: Write the failing test**

`src/backend/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadBackendConfig } from "./config.js";

describe("loadBackendConfig", () => {
  it("reads DB path and port from env", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", BACKEND_PORT: "4000" });
    expect(cfg).toEqual({ dbPath: "/tmp/x.db", port: 4000 });
  });

  it("defaults the port to 3100 when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db" });
    expect(cfg.port).toBe(3100);
  });

  it("fails fast when the DB path is missing (no silent default)", () => {
    expect(() => loadBackendConfig({})).toThrow(/BEAR_METAL_DB_PATH/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Write `src/backend/config.ts`**

```ts
export interface BackendConfig {
  dbPath: string;
  port: number;
}

/**
 * Backend env config. The DB path is mandatory — a missing value is a configuration
 * error and must fail fast rather than fall back to a guessed location.
 */
export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const dbPath = env.BEAR_METAL_DB_PATH;
  if (!dbPath) {
    throw new Error("BEAR_METAL_DB_PATH is required but was not set");
  }
  return { dbPath, port: Number(env.BACKEND_PORT ?? 3100) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/config.ts src/backend/config.test.ts
git commit -m "feat(backend): [DEN-2271] add fail-fast backend config loader"
```

---

## Task 6: Repository (query layer)

**Files:**
- Create: `src/backend/db/repository.ts`
- Test: `src/backend/db/repository.test.ts`

Functions: `listTickets(db, filter?)`, `getTicketDetail(db, id)`, `listWorkers(db)`.

- [ ] **Step 1: Write the failing test**

`src/backend/db/repository.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { seedMockData } from "../mock/seed.js";
import { listTickets, getTicketDetail, listWorkers } from "./repository.js";

let db: BetterSQLite3Database<typeof schema>;
beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
});

describe("listTickets", () => {
  it("returns all tickets newest-first with attempt + latest PR/CI summary", () => {
    const rows = listTickets(db);
    expect(rows.length).toBe(4);
    expect(rows[0]!.createdAt >= rows[1]!.createdAt).toBe(true);
    const completed = rows.find((r) => r.identifier === "DEN-3001")!;
    expect(completed.bmStatus).toBe("completed");
    expect(completed.latestPr?.number).toBe(1500);
    expect(completed.latestCiStatus).toBe("passed");
    expect(completed.attemptCount).toBe(1);
  });

  it("filters by bmStatus", () => {
    const rows = listTickets(db, { bmStatus: "abandoned" });
    expect(rows.map((r) => r.identifier)).toEqual(["DEN-3003"]);
  });
});

describe("getTicketDetail", () => {
  it("returns the ticket with runs, PRs, CI runs, and an ordered event timeline", () => {
    const detail = getTicketDetail(db, "lin_2")!;
    expect(detail.ticket.identifier).toBe("DEN-3002");
    expect(detail.runs.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(detail.runs[1]!.worker?.name).toBe("worker-2");
    expect(detail.pullRequests[0]!.number).toBe(1501);
    expect(detail.ciRuns.some((c) => c.status === "failed")).toBe(true);
    expect(detail.events[0]!.createdAt <= detail.events.at(-1)!.createdAt).toBe(true);
  });

  it("returns null for an unknown ticket", () => {
    expect(getTicketDetail(db, "nope")).toBeNull();
  });
});

describe("listWorkers", () => {
  it("returns workers with their current ticket identifier when busy", () => {
    const rows = listWorkers(db);
    expect(rows.length).toBe(3);
    const busy = rows.find((w) => w.id === "wk_1")!;
    expect(busy.status).toBe("busy");
    expect(busy.currentTicketIdentifier).toBe("DEN-3004");
    expect(rows.some((w) => w.status === "dead")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/backend/db/repository.test.ts`
Expected: FAIL — `Cannot find module './repository.js'`.

- [ ] **Step 3: Write `src/backend/db/repository.ts`**

```ts
import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type { Ticket, Run, PullRequestRow, CiRun, EventRow, Worker } from "./types.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface TicketListItem extends Ticket {
  latestPr: { number: number; url: string; state: string; merged: boolean } | null;
  latestCiStatus: "running" | "passed" | "failed" | null;
}

export interface TicketDetail {
  ticket: Ticket;
  runs: (Run & { worker: Worker | null })[];
  pullRequests: PullRequestRow[];
  ciRuns: CiRun[];
  events: EventRow[];
}

export interface WorkerListItem extends Worker {
  currentTicketIdentifier: string | null;
}

export function listTickets(db: Db, filter?: { bmStatus?: Ticket["bmStatus"] }): TicketListItem[] {
  const where = filter?.bmStatus ? eq(schema.tickets.bmStatus, filter.bmStatus) : undefined;
  const ticketRows = db.select().from(schema.tickets).where(where).orderBy(desc(schema.tickets.createdAt)).all();

  return ticketRows.map((ticket) => {
    const prs = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.ticketId, ticket.id)).orderBy(desc(schema.pullRequests.updatedAt)).all();
    const latestPrRow = prs[0] ?? null;
    const ci = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, ticket.id)).orderBy(desc(schema.ciRuns.createdAt)).all();
    return {
      ...ticket,
      latestPr: latestPrRow ? { number: latestPrRow.number, url: latestPrRow.url, state: latestPrRow.state, merged: latestPrRow.merged } : null,
      latestCiStatus: ci[0]?.status ?? null,
    };
  });
}

export function getTicketDetail(db: Db, id: string): TicketDetail | null {
  const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).get();
  if (!ticket) return null;

  const runRows = db.select().from(schema.runs).where(eq(schema.runs.ticketId, id)).orderBy(schema.runs.attemptNumber).all();
  const workersById = new Map(db.select().from(schema.workers).all().map((w) => [w.id, w]));
  const runs = runRows.map((r) => ({ ...r, worker: r.workerId ? workersById.get(r.workerId) ?? null : null }));

  const pullRequests = db.select().from(schema.pullRequests).where(eq(schema.pullRequests.ticketId, id)).orderBy(desc(schema.pullRequests.updatedAt)).all();
  const ciRuns = db.select().from(schema.ciRuns).where(eq(schema.ciRuns.ticketId, id)).orderBy(schema.ciRuns.createdAt).all();
  const events = db.select().from(schema.events).where(eq(schema.events.ticketId, id)).orderBy(schema.events.createdAt).all();

  return { ticket, runs, pullRequests, ciRuns, events };
}

export function listWorkers(db: Db): WorkerListItem[] {
  const workers = db.select().from(schema.workers).all();
  return workers.map((w) => {
    let currentTicketIdentifier: string | null = null;
    if (w.currentRunId) {
      const run = db.select().from(schema.runs).where(eq(schema.runs.id, w.currentRunId)).get();
      if (run) {
        const ticket = db.select().from(schema.tickets).where(eq(schema.tickets.id, run.ticketId)).get();
        currentTicketIdentifier = ticket?.identifier ?? null;
      }
    }
    return { ...w, currentTicketIdentifier };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/backend/db/repository.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/repository.ts src/backend/db/repository.test.ts
git commit -m "feat(backend): [DEN-2271] add ticket/worker query repository"
```

---

## Task 7: Auth seam, app factory, and routes

**Files:**
- Create: `src/backend/middleware/auth.ts`
- Create: `src/backend/routes/index.ts`
- Create: `src/backend/app.ts`

- [ ] **Step 1: Write `src/backend/middleware/auth.ts`** (no test — trivial pass-through seam)

```ts
import type { RequestHandler } from "express";

/**
 * No-op auth seam. Local-only MVP has no auth; a real implementation slots in here
 * later (e.g. WorkOS) without touching route handlers.
 */
export const authStub: RequestHandler = (_req, _res, next) => next();
```

- [ ] **Step 2: Write `src/backend/routes/index.ts`**

```ts
import { Router } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { listTickets, getTicketDetail, listWorkers } from "../db/repository.js";

const BM_STATUSES = ["discovered", "dispatched", "in_progress", "pr_open", "ci_running", "ci_failed", "completed", "abandoned"] as const;
type BmStatus = (typeof BM_STATUSES)[number];

export function createRouter(db: BetterSQLite3Database<typeof schema>): Router {
  const router = Router();

  router.get("/health", (_req, res) => res.json({ status: "ok" }));

  router.get("/tickets", (req, res) => {
    const status = req.query.status;
    if (status !== undefined && !BM_STATUSES.includes(status as BmStatus)) {
      return res.status(400).json({ error: `invalid status filter: ${String(status)}` });
    }
    res.json({ tickets: listTickets(db, status ? { bmStatus: status as BmStatus } : undefined) });
  });

  router.get("/tickets/:id", (req, res) => {
    const detail = getTicketDetail(db, req.params.id);
    if (!detail) return res.status(404).json({ error: "ticket not found" });
    res.json(detail);
  });

  router.get("/workers", (_req, res) => res.json({ workers: listWorkers(db) }));

  return router;
}
```

- [ ] **Step 3: Write `src/backend/app.ts`**

```ts
import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";

/** Build the Express app around an already-opened (read-only) DB. DB is injected so tests can pass a seeded in-memory DB. */
export function createApp(db: BetterSQLite3Database<typeof schema>): Express {
  const app = express();
  app.use(authStub);
  app.use("/api", createRouter(db));
  return app;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/middleware/auth.ts src/backend/routes/index.ts src/backend/app.ts
git commit -m "feat(backend): [DEN-2271] add express app factory, routes, auth seam"
```

---

## Task 8: API integration tests

**Files:**
- Test: `src/backend/routes/api.test.ts`

- [ ] **Step 1: Write the test**

`src/backend/routes/api.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { seedMockData } from "../mock/seed.js";
import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  const sqlite = new Database(":memory:");
  const db: BetterSQLite3Database<typeof schema> = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  seedMockData(db);
  app = createApp(db);
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/tickets", () => {
  it("lists tickets newest-first with summaries", async () => {
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body.tickets.length).toBe(4);
    expect(res.body.tickets[0].identifier).toBe("DEN-3004"); // newest createdAt
  });

  it("filters by status", async () => {
    const res = await request(app).get("/api/tickets?status=abandoned");
    expect(res.status).toBe(200);
    expect(res.body.tickets.map((t: { identifier: string }) => t.identifier)).toEqual(["DEN-3003"]);
  });

  it("rejects an invalid status filter (fail-fast, not silently ignored)", async () => {
    const res = await request(app).get("/api/tickets?status=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tickets/:id", () => {
  it("returns full detail", async () => {
    const res = await request(app).get("/api/tickets/lin_2");
    expect(res.status).toBe(200);
    expect(res.body.ticket.identifier).toBe("DEN-3002");
    expect(res.body.runs.length).toBe(2);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("404s for an unknown ticket", async () => {
    const res = await request(app).get("/api/tickets/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/workers", () => {
  it("lists workers with current ticket", async () => {
    const res = await request(app).get("/api/workers");
    expect(res.status).toBe(200);
    expect(res.body.workers.length).toBe(3);
    expect(res.body.workers.find((w: { id: string }) => w.id === "wk_1").currentTicketIdentifier).toBe("DEN-3004");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- src/backend/routes/api.test.ts`
Expected: PASS (all cases).

- [ ] **Step 3: Commit**

```bash
git add src/backend/routes/api.test.ts
git commit -m "test(backend): [DEN-2271] add API integration tests"
```

---

## Task 9: Backend entrypoint

**Files:**
- Create: `src/backend/index.ts`

- [ ] **Step 1: Write `src/backend/index.ts`**

```ts
import "dotenv/config";
import { logger } from "../shared/logger.js";
import { loadBackendConfig } from "./config.js";
import { openReadOnlyDb } from "./db/client.js";
import { createApp } from "./app.js";

function main(): void {
  const { dbPath, port } = loadBackendConfig();
  const { db } = openReadOnlyDb(dbPath); // fail-fast if the file is missing
  const app = createApp(db);
  app.listen(port, () => logger.info({ port, dbPath }, "bear-metal dashboard backend listening"));
}

main();
```
(If `src/shared/logger.ts` does not export `logger`, import the name it actually exports — check the barrel `src/shared/index.ts` and match it.)

- [ ] **Step 2: Build and smoke-test end to end**

Run:
```bash
BEAR_METAL_DB_PATH=./tmp.db npm run seed:mock
BEAR_METAL_DB_PATH=./tmp.db BACKEND_PORT=3100 npm run dev:backend &
sleep 2
curl -s localhost:3100/api/tickets | head -c 200
curl -s localhost:3100/api/workers | head -c 200
kill %1; rm ./tmp.db
```
Expected: JSON arrays of tickets and workers; log line on startup.

- [ ] **Step 3: Run the full backend test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/backend/index.ts
git commit -m "feat(backend): [DEN-2271] add dashboard backend entrypoint"
```

---

## Self-Review

- **Spec coverage:** schema (Task 1) ✓, read-only fail-fast client (Task 3) ✓, mock seeder with the full scenario incl. iteration limit / CI-failure retry / dead worker (Task 4) ✓, `/api/tickets`, `/api/tickets/:id`, `/api/workers`, `/api/health` (Tasks 7–8) ✓, auth seam (Task 7) ✓, integration tests (Task 8) ✓, `src/ui` tsconfig exclusion (Task 0) ✓. Recharts/UI are out of scope (separate UI plan).
- **Placeholder scan:** all code steps contain full code; commands have expected output. The one cross-task note (logger export name) is flagged with how to resolve, not left vague.
- **Type consistency:** `BmStatus` matches the schema enum; `TicketListItem`/`TicketDetail`/`WorkerListItem` field names used in tests match `repository.ts`; `seedMockData` ids referenced in repository/API tests (`lin_2`, `wk_1`, `DEN-3004`) match the seeder.

---

## Acceptance Criteria (backend)

- [ ] `src/backend/` added to the root package; `src/ui` excluded from root tsc.
- [ ] Drizzle schema + migration for all six tables, mirroring existing domain types.
- [ ] Read-only client fails fast on a missing DB file.
- [ ] Seeder produces the multi-attempt / CI-failure / dead-worker scenario; idempotent.
- [ ] Express API serves all four endpoints; invalid filter → 400; unknown ticket → 404.
- [ ] `npm test` (schema, client, config, seed, repository, API) and `npm run typecheck` pass.
