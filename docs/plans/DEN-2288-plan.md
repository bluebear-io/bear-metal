# Observability Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live bear-metal manager + worker write their real ticket / run / PR / CI / worker state and history into the dashboard DB via HTTP write endpoints, replacing the mock seed as the dashboard's data source.

**Architecture:** The backend process opens the dashboard SQLite **read-write** and exposes idempotent upsert endpoints under `/api` behind a shared-secret bearer guard. The manager/worker (one process) reach those endpoints through a thin best-effort HTTP `DashboardClient`; a `DashboardReporter` translates the agent's lifecycle moments into table rows + events (owning the `bm_status` and event-type mapping). Dashboard writes are non-fatal by design — a failed write logs and returns, never breaking the agent loop (approved deviation from fail-fast, see spec §2).

**Tech Stack:** TypeScript (ESM/NodeNext), Express, drizzle-orm + better-sqlite3, vitest + supertest, pino. Spec: `docs/plans/DEN-2288.md`.

---

## File Structure

**Backend (write side):**
- `src/backend/db/client.ts` — add `openReadWriteDb` (modify).
- `src/backend/db/writer.ts` — **new**: per-table upsert/insert functions.
- `src/backend/routes/ingest.ts` — **new**: write router, payload validation, bearer guard.
- `src/backend/config.ts` — add `ingestToken` (modify).
- `src/backend/app.ts` — mount ingest router when a token is configured (modify).
- `src/backend/index.ts` — open RW db, pass token (modify).

**Shared (transport + wire types):**
- `src/shared/dashboard/types.ts` — **new**: JSON wire payload types (shared by client + backend).
- `src/shared/dashboard/client.ts` — **new**: best-effort HTTP `DashboardClient`.
- `src/shared/index.ts` — export the dashboard client + types (modify).

**Manager/worker (projection + wiring):**
- `src/manager/dashboardReporter.ts` — **new**: semantic lifecycle → rows/events, owns `bm_status`/event mapping.
- `src/manager/tasks.ts` — add `trigger` + `attemptNumber` to task input/row (modify).
- `src/manager/ticket-handler.ts` — emit `dispatched` (modify).
- `src/manager/scheduler.ts` — emit ticket/PR/CI/run transitions (modify).
- `src/worker/task-worker.ts` — worker row + run started/finished/crashed + `pr_opened` (modify).
- `src/worker/dispatch.ts` — emit `progress`/`branch_created` (modify).
- `src/manager/config.ts` — add `dashboardUrl`, `ingestToken` (modify).
- `src/manager/index.ts` — construct client + reporter, inject (modify).

---

## Conventions for every task
- Run tests with `npx vitest run <path>`; typecheck with `npm run typecheck`.
- Timestamps cross the wire as **epoch-ms numbers**; the backend converts to `Date` for drizzle (`timestamp_ms` mode).
- Enums are validated at the route boundary against `schema.<table>.<col>.enumValues` (the pattern already in `routes/index.ts`). Invalid/missing → HTTP 400 (fail-fast).
- Commit after each task with a conventional message ending in the repo's `Co-Authored-By` trailer.

---

## Task 1: Read-write DB client

**Files:**
- Modify: `src/backend/db/client.ts`
- Test: `src/backend/db/client.test.ts` (exists — add a case)

- [ ] **Step 1: Write the failing test**

Add to `src/backend/db/client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { openReadWriteDb } from "./client.js";

describe("openReadWriteDb", () => {
  it("opens an existing file writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-rw-"));
    const path = join(dir, "dash.sqlite");
    // create + migrate the file first
    const seed = drizzle(new Database(path), { schema });
    migrate(seed, { migrationsFolder: "./src/backend/db/migrations" });

    const { db, sqlite } = openReadWriteDb(path);
    db.insert(schema.workers)
      .values({ id: "w1", name: "n", status: "idle", currentRunId: null, lastHeartbeatAt: null, startedAt: new Date(1), updatedAt: new Date(1) })
      .run();
    const rows = db.select().from(schema.workers).all();
    sqlite.close();
    expect(rows).toHaveLength(1);
  });

  it("fails fast when the file is missing", () => {
    expect(() => openReadWriteDb("/no/such/file.sqlite")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backend/db/client.test.ts`
Expected: FAIL — `openReadWriteDb` is not exported.

- [ ] **Step 3: Implement**

In `src/backend/db/client.ts`, add below `openReadOnlyDb`:

```ts
/**
 * Opens the dashboard SQLite read-write. The backend process is the SOLE writer, so the
 * manager/worker never open this file directly (they go through the HTTP write API) — this
 * keeps a single writer and avoids cross-process SQLite contention. Fails fast on a missing
 * file: the DB is created/migrated out of band, never silently here.
 */
export function openReadWriteDb(path: string): ReadOnlyDb {
  if (!existsSync(path)) {
    throw new Error(`Bear Metal database file not found at "${path}"`);
  }
  const sqlite = new Database(path, { fileMustExist: true });
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/backend/db/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/client.ts src/backend/db/client.test.ts
git commit -m "feat(backend): [DEN-2288] add read-write dashboard DB client"
```

---

## Task 2: Wire payload types (shared)

**Files:**
- Create: `src/shared/dashboard/types.ts`

These are the JSON shapes that cross the HTTP boundary. Timestamps are epoch-ms numbers; labels are an array (the backend serializes to `labelsJson`).

- [ ] **Step 1: Create the types**

```ts
// src/shared/dashboard/types.ts

export type BmStatus =
  | "discovered" | "dispatched" | "in_progress" | "pr_open"
  | "ci_running" | "ci_failed" | "completed" | "abandoned";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type RunTrigger = "new" | "ci_failure" | "delegated_back";
export type StopReason = "completed" | "timeout" | "crash" | "error";
export type CiStatus = "running" | "passed" | "failed";
export type EventSource = "manager" | "worker" | "ci";
export type EventType =
  | "ticket_discovered" | "dispatched" | "branch_created" | "progress"
  | "pr_opened" | "ci_started" | "ci_passed" | "ci_failed" | "delegated_back"
  | "worker_timeout" | "worker_crashed" | "ticket_completed" | "ticket_abandoned";

export interface TicketPayload {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  linearStatusName: string;
  linearStatusType: string;
  labels: string[];
  bmStatus: BmStatus;
  attemptCount: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkerPayload {
  id: string;
  name: string;
  status: WorkerStatus;
  currentRunId: string | null;
  lastHeartbeatAt: number | null;
  startedAt: number;
  updatedAt: number;
}

export interface RunPayload {
  id: string;
  ticketId: string;
  attemptNumber: number;
  workerId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  contextJson: string | null;
  startedAt: number | null;
  endedAt: number | null;
  stopReason: StopReason | null;
  error: string | null;
  createdAt: number;
}

export interface PullRequestPayload {
  id: string;
  ticketId: string;
  number: number;
  title: string;
  headRef: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  url: string;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CiRunPayload {
  id: string;
  ticketId: string;
  runId: string;
  prId: string | null;
  status: CiStatus;
  url: string | null;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface EventPayload {
  ticketId: string | null;
  runId: string | null;
  workerId: string | null;
  source: EventSource;
  type: EventType;
  summary: string;
  payloadJson: string | null;
  createdAt: number;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/shared/dashboard/types.ts
git commit -m "feat(shared): [DEN-2288] add dashboard wire payload types"
```

---

## Task 3: Backend writer module

**Files:**
- Create: `src/backend/db/writer.ts`
- Test: `src/backend/db/writer.test.ts`

Converts a validated payload into a drizzle upsert. Timestamp conversion (number → Date) and `labels` → `labelsJson` happen here so the route stays thin.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/db/writer.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { upsertTicket, upsertRun, insertEvent } from "./writer.js";

let db: BetterSQLite3Database<typeof schema>;
beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
});

const ticket = {
  id: "lin_9", identifier: "DEN-9", title: "t", description: null, url: "u",
  branchName: "b", linearStatusName: "Todo", linearStatusType: "unstarted",
  labels: ["bear-metal"], bmStatus: "discovered" as const, attemptCount: 0,
  maxAttempts: 5, createdAt: 1000, updatedAt: 1000, completedAt: null,
};

describe("upsertTicket", () => {
  it("inserts then updates the same id (idempotent)", () => {
    upsertTicket(db, ticket);
    upsertTicket(db, { ...ticket, bmStatus: "in_progress", updatedAt: 2000 });
    const rows = db.select().from(schema.tickets).where(eq(schema.tickets.id, "lin_9")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].bmStatus).toBe("in_progress");
    expect(rows[0].labelsJson).toBe(JSON.stringify(["bear-metal"]));
    expect(rows[0].updatedAt).toEqual(new Date(2000));
  });
});

describe("upsertRun + insertEvent", () => {
  it("persists a run and appends an event", () => {
    upsertTicket(db, ticket);
    upsertRun(db, {
      id: "run_9", ticketId: "lin_9", attemptNumber: 1, workerId: null,
      trigger: "new", status: "dispatched", contextJson: null,
      startedAt: null, endedAt: null, stopReason: null, error: null, createdAt: 1500,
    });
    insertEvent(db, {
      ticketId: "lin_9", runId: "run_9", workerId: null, source: "manager",
      type: "dispatched", summary: "enqueued", payloadJson: null, createdAt: 1500,
    });
    expect(db.select().from(schema.runs).all()).toHaveLength(1);
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/backend/db/writer.test.ts`
Expected: FAIL — `writer.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/backend/db/writer.ts
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload, EventPayload,
} from "../../shared/dashboard/types.js";

type Db = BetterSQLite3Database<typeof schema>;
const d = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

export function upsertTicket(db: Db, p: TicketPayload): void {
  const row = {
    id: p.id, identifier: p.identifier, title: p.title, description: p.description,
    url: p.url, branchName: p.branchName, linearStatusName: p.linearStatusName,
    linearStatusType: p.linearStatusType, labelsJson: JSON.stringify(p.labels),
    bmStatus: p.bmStatus, attemptCount: p.attemptCount, maxAttempts: p.maxAttempts,
    createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt), completedAt: d(p.completedAt),
  };
  db.insert(schema.tickets).values(row).onConflictDoUpdate({ target: schema.tickets.id, set: row }).run();
}

export function upsertWorker(db: Db, p: WorkerPayload): void {
  const row = {
    id: p.id, name: p.name, status: p.status, currentRunId: p.currentRunId,
    lastHeartbeatAt: d(p.lastHeartbeatAt), startedAt: new Date(p.startedAt), updatedAt: new Date(p.updatedAt),
  };
  db.insert(schema.workers).values(row).onConflictDoUpdate({ target: schema.workers.id, set: row }).run();
}

export function upsertRun(db: Db, p: RunPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, attemptNumber: p.attemptNumber, workerId: p.workerId,
    trigger: p.trigger, status: p.status, contextJson: p.contextJson,
    startedAt: d(p.startedAt), endedAt: d(p.endedAt), stopReason: p.stopReason, error: p.error,
    createdAt: new Date(p.createdAt),
  };
  db.insert(schema.runs).values(row).onConflictDoUpdate({ target: schema.runs.id, set: row }).run();
}

export function upsertPullRequest(db: Db, p: PullRequestPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, number: p.number, title: p.title, headRef: p.headRef,
    state: p.state, draft: p.draft, merged: p.merged, url: p.url, lastRunId: p.lastRunId,
    createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt),
  };
  db.insert(schema.pullRequests).values(row).onConflictDoUpdate({ target: schema.pullRequests.id, set: row }).run();
}

export function upsertCiRun(db: Db, p: CiRunPayload): void {
  const row = {
    id: p.id, ticketId: p.ticketId, runId: p.runId, prId: p.prId, status: p.status,
    url: p.url, summary: p.summary, createdAt: new Date(p.createdAt), completedAt: d(p.completedAt),
  };
  db.insert(schema.ciRuns).values(row).onConflictDoUpdate({ target: schema.ciRuns.id, set: row }).run();
}

export function insertEvent(db: Db, p: EventPayload): void {
  db.insert(schema.events).values({
    id: globalThis.crypto.randomUUID(),
    ticketId: p.ticketId, runId: p.runId, workerId: p.workerId, source: p.source,
    type: p.type, summary: p.summary, payloadJson: p.payloadJson, createdAt: new Date(p.createdAt),
  }).run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/backend/db/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db/writer.ts src/backend/db/writer.test.ts
git commit -m "feat(backend): [DEN-2288] add dashboard table writer functions"
```

---

## Task 4: Ingest router (validation + bearer guard) and mount

**Files:**
- Create: `src/backend/routes/ingest.ts`
- Modify: `src/backend/config.ts`, `src/backend/app.ts`, `src/backend/index.ts`
- Test: `src/backend/routes/ingest.test.ts`

### 4a — config

- [ ] **Step 1: Add `ingestToken` to config**

In `src/backend/config.ts`, add to `BackendConfig`:

```ts
  /** Shared secret required on write (ingest) routes. Empty disables the write API. */
  ingestToken: string;
```

and in the returned object in `loadBackendConfig`:

```ts
    ingestToken: env.INGEST_TOKEN ?? "",
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` (config-only; existing `config.test.ts` still passes).

### 4b — router

- [ ] **Step 3: Write the failing integration test**

```ts
// src/backend/routes/ingest.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { createApp } from "../app.js";

const TOKEN = "secret-123";
let app: ReturnType<typeof createApp>;
let db: BetterSQLite3Database<typeof schema>;

beforeEach(() => {
  db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  app = createApp(db, { ingestToken: TOKEN });
});

const ticketBody = {
  id: "lin_x", identifier: "DEN-X", title: "t", description: null, url: "u", branchName: "b",
  linearStatusName: "Todo", linearStatusType: "unstarted", labels: ["bear-metal"],
  bmStatus: "discovered", attemptCount: 0, maxAttempts: 5,
  createdAt: 1000, updatedAt: 1000, completedAt: null,
};

describe("write auth", () => {
  it("rejects a missing token with 401", async () => {
    const res = await request(app).put("/api/tickets/lin_x").send(ticketBody);
    expect(res.status).toBe(401);
  });
  it("rejects a wrong token with 401", async () => {
    const res = await request(app).put("/api/tickets/lin_x").set("authorization", "Bearer nope").send(ticketBody);
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/tickets/:id", () => {
  it("upserts and is then visible to the read API", async () => {
    const put = await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    expect(put.status).toBe(204);
    const get = await request(app).get("/api/tickets/lin_x");
    expect(get.status).toBe(200);
    expect(get.body.ticket.bmStatus).toBe("discovered");
  });
  it("rejects an invalid bmStatus with 400", async () => {
    const res = await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send({ ...ticketBody, bmStatus: "bogus" });
    expect(res.status).toBe(400);
  });
  it("rejects a mismatched id (path vs body) with 400", async () => {
    const res = await request(app).put("/api/tickets/other").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/events", () => {
  it("appends an event", async () => {
    await request(app).put("/api/tickets/lin_x").set("authorization", `Bearer ${TOKEN}`).send(ticketBody);
    const res = await request(app).post("/api/events").set("authorization", `Bearer ${TOKEN}`).send({
      ticketId: "lin_x", runId: null, workerId: null, source: "manager",
      type: "ticket_discovered", summary: "picked up", payloadJson: null, createdAt: 1000,
    });
    expect(res.status).toBe(204);
    const detail = await request(app).get("/api/tickets/lin_x");
    expect(detail.body.events.length).toBe(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/backend/routes/ingest.test.ts`
Expected: FAIL — `createApp` does not accept a second argument / ingest routes 404.

- [ ] **Step 5: Implement the router**

```ts
// src/backend/routes/ingest.ts
import { Router, type RequestHandler } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { upsertTicket, upsertWorker, upsertRun, upsertPullRequest, upsertCiRun, insertEvent } from "../db/writer.js";

type Db = BetterSQLite3Database<typeof schema>;

// Field-level validation: presence, type, and enum membership. Fail-fast — a bad payload is a
// caller bug, never coerced. `req.body` is unknown JSON until validated here.
class BadPayload extends Error {}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new BadPayload(`${k} must be a non-empty string`);
  return v;
}
function strOrNull(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "string") throw new BadPayload(`${k} must be a string or null`);
  return v;
}
function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadPayload(`${k} must be a number`);
  return v;
}
function numOrNull(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadPayload(`${k} must be a number or null`);
  return v;
}
function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new BadPayload(`${k} must be a boolean`);
  return v;
}
function strArray(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadPayload(`${k} must be a string[]`);
  return v as string[];
}
function enumVal<T extends readonly string[]>(o: Record<string, unknown>, k: string, vals: T): T[number] {
  const v = o[k];
  if (typeof v !== "string" || !(vals as readonly string[]).includes(v)) throw new BadPayload(`${k} must be one of: ${vals.join(", ")}`);
  return v as T[number];
}
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadPayload("body must be a JSON object");
  return body as Record<string, unknown>;
}

export function createIngestRouter(db: Db, token: string): Router {
  const router = Router();

  const requireToken: RequestHandler = (req, res, next) => {
    const header = req.header("authorization") ?? "";
    if (header !== `Bearer ${token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
  router.use(requireToken);

  // Wrap a parse+write in fail-fast 400 handling.
  const handle = (fn: (body: Record<string, unknown>, id?: string) => void): RequestHandler => (req, res) => {
    try {
      fn(asObject(req.body), req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof BadPayload) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  };

  router.put("/tickets/:id", handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertTicket(db, {
      id: bodyId, identifier: str(b, "identifier"), title: str(b, "title"),
      description: strOrNull(b, "description"), url: str(b, "url"), branchName: str(b, "branchName"),
      linearStatusName: str(b, "linearStatusName"), linearStatusType: str(b, "linearStatusType"),
      labels: strArray(b, "labels"), bmStatus: enumVal(b, "bmStatus", schema.tickets.bmStatus.enumValues),
      attemptCount: num(b, "attemptCount"), maxAttempts: num(b, "maxAttempts"),
      createdAt: num(b, "createdAt"), updatedAt: num(b, "updatedAt"), completedAt: numOrNull(b, "completedAt"),
    });
  }));

  router.put("/workers/:id", handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertWorker(db, {
      id: bodyId, name: str(b, "name"), status: enumVal(b, "status", schema.workers.status.enumValues),
      currentRunId: strOrNull(b, "currentRunId"), lastHeartbeatAt: numOrNull(b, "lastHeartbeatAt"),
      startedAt: num(b, "startedAt"), updatedAt: num(b, "updatedAt"),
    });
  }));

  router.put("/runs/:id", handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertRun(db, {
      id: bodyId, ticketId: str(b, "ticketId"), attemptNumber: num(b, "attemptNumber"),
      workerId: strOrNull(b, "workerId"), trigger: enumVal(b, "trigger", schema.runs.trigger.enumValues),
      status: enumVal(b, "status", schema.runs.status.enumValues), contextJson: strOrNull(b, "contextJson"),
      startedAt: numOrNull(b, "startedAt"), endedAt: numOrNull(b, "endedAt"),
      stopReason: b.stopReason === null ? null : enumVal(b, "stopReason", schema.runs.stopReason.enumValues),
      error: strOrNull(b, "error"), createdAt: num(b, "createdAt"),
    });
  }));

  router.put("/pull-requests/:id", handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertPullRequest(db, {
      id: bodyId, ticketId: str(b, "ticketId"), number: num(b, "number"), title: str(b, "title"),
      headRef: str(b, "headRef"), state: enumVal(b, "state", schema.pullRequests.state.enumValues),
      draft: bool(b, "draft"), merged: bool(b, "merged"), url: str(b, "url"),
      lastRunId: strOrNull(b, "lastRunId"), createdAt: num(b, "createdAt"), updatedAt: num(b, "updatedAt"),
    });
  }));

  router.put("/ci-runs/:id", handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertCiRun(db, {
      id: bodyId, ticketId: str(b, "ticketId"), runId: str(b, "runId"), prId: strOrNull(b, "prId"),
      status: enumVal(b, "status", schema.ciRuns.status.enumValues), url: strOrNull(b, "url"),
      summary: strOrNull(b, "summary"), createdAt: num(b, "createdAt"), completedAt: numOrNull(b, "completedAt"),
    });
  }));

  router.post("/events", handle((b) => {
    insertEvent(db, {
      ticketId: strOrNull(b, "ticketId"), runId: strOrNull(b, "runId"), workerId: strOrNull(b, "workerId"),
      source: enumVal(b, "source", schema.events.source.enumValues),
      type: enumVal(b, "type", schema.events.type.enumValues),
      summary: str(b, "summary"), payloadJson: strOrNull(b, "payloadJson"), createdAt: num(b, "createdAt"),
    });
  }));

  return router;
}
```

- [ ] **Step 6: Mount it in `app.ts`**

Replace `src/backend/app.ts` body:

```ts
import express, { type Express } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";
import { createIngestRouter } from "./routes/ingest.js";

export interface AppOptions {
  /** Shared secret enabling the write (ingest) API. Empty/omitted → read-only server. */
  ingestToken?: string;
}

/** Build the Express app around an opened DB. A non-empty ingestToken mounts the write API. */
export function createApp(db: BetterSQLite3Database<typeof schema>, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(authStub);
  if (options.ingestToken) {
    app.use("/api", createIngestRouter(db, options.ingestToken));
  }
  app.use("/api", createRouter(db));
  return app;
}
```

- [ ] **Step 7: Open RW + pass token in `index.ts`**

In `src/backend/index.ts`: change the import `openReadOnlyDb` → `openReadWriteDb`, the call `openReadWriteDb(dbPath)`, and `const app = createApp(db, { ingestToken: config.ingestToken });`.

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/backend`
Expected: PASS — ingest tests pass and the existing `api.test.ts` (calls `createApp(db)` with no options) still passes.

- [ ] **Step 9: Commit**

```bash
git add src/backend/routes/ingest.ts src/backend/routes/ingest.test.ts src/backend/app.ts src/backend/index.ts src/backend/config.ts
git commit -m "feat(backend): [DEN-2288] add authenticated dashboard write endpoints"
```

---

## Task 5: Best-effort dashboard HTTP client (shared)

**Files:**
- Create: `src/shared/dashboard/client.ts`
- Modify: `src/shared/index.ts`
- Test: `src/shared/dashboard/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/dashboard/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { createDashboardClient } from "./client.js";
import { createLogger } from "../logger.js";

const logger = createLogger({ level: "silent", name: "test" });
const ticket = {
  id: "lin_x", identifier: "DEN-X", title: "t", description: null, url: "u", branchName: "b",
  linearStatusName: "Todo", linearStatusType: "unstarted", labels: [], bmStatus: "discovered" as const,
  attemptCount: 0, maxAttempts: 5, createdAt: 1, updatedAt: 1, completedAt: null,
};

describe("createDashboardClient", () => {
  it("PUTs to the right URL with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    const client = createDashboardClient({ baseUrl: "http://host:3100", token: "tok", logger, fetchImpl });
    await client.upsertTicket(ticket);
    expect(fetchImpl).toHaveBeenCalledWith("http://host:3100/api/tickets/lin_x", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ authorization: "Bearer tok", "content-type": "application/json" }),
      body: JSON.stringify(ticket),
    }));
  });

  it("swallows a non-ok response (best-effort, never throws)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as unknown as Response);
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    await expect(client.upsertTicket(ticket)).resolves.toBeUndefined();
  });

  it("swallows a network throw (best-effort, never throws)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    await expect(client.recordEvent({ ticketId: null, runId: null, workerId: null, source: "manager", type: "progress", summary: "x", payloadJson: null, createdAt: 1 })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/dashboard/client.test.ts`
Expected: FAIL — `client.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/shared/dashboard/client.ts
import type { Logger } from "../logger.js";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload, EventPayload,
} from "./types.js";

export interface DashboardClientOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface DashboardClient {
  upsertTicket(p: TicketPayload): Promise<void>;
  upsertWorker(p: WorkerPayload): Promise<void>;
  upsertRun(p: RunPayload): Promise<void>;
  upsertPullRequest(p: PullRequestPayload): Promise<void>;
  upsertCiRun(p: CiRunPayload): Promise<void>;
  recordEvent(p: EventPayload): Promise<void>;
}

/**
 * Best-effort transport to the dashboard write API. The dashboard is a read model, not the
 * system of record, so a failed write is logged and swallowed — it must never break the agent
 * loop. (Approved deviation from the repo's fail-fast rule; see DEN-2288 spec §2.)
 */
export function createDashboardClient(options: DashboardClientOptions): DashboardClient {
  const { baseUrl, token, logger } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = baseUrl.replace(/\/$/, "");

  async function send(method: "PUT" | "POST", path: string, body: unknown): Promise<void> {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = typeof res.text === "function" ? await res.text().catch(() => "") : "";
        logger.warn({ path, status: res.status, detail }, "dashboard write rejected");
      }
    } catch (err) {
      logger.warn({ err, path }, "dashboard write failed (ignored)");
    }
  }

  return {
    upsertTicket: (p) => send("PUT", `/api/tickets/${encodeURIComponent(p.id)}`, p),
    upsertWorker: (p) => send("PUT", `/api/workers/${encodeURIComponent(p.id)}`, p),
    upsertRun: (p) => send("PUT", `/api/runs/${encodeURIComponent(p.id)}`, p),
    upsertPullRequest: (p) => send("PUT", `/api/pull-requests/${encodeURIComponent(p.id)}`, p),
    upsertCiRun: (p) => send("PUT", `/api/ci-runs/${encodeURIComponent(p.id)}`, p),
    recordEvent: (p) => send("POST", `/api/events`, p),
  };
}
```

Note: the first test asserts the URL has no `encodeURIComponent` effect for `lin_x` (unchanged). Keep `id: "lin_x"` in the test so the encoded and raw forms are identical.

- [ ] **Step 4: Export from the barrel**

In `src/shared/index.ts`, add:

```ts
export { createDashboardClient, type DashboardClient, type DashboardClientOptions } from "./dashboard/client.js";
export type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload, EventPayload,
  BmStatus, RunStatus, RunTrigger, StopReason, CiStatus, EventType, EventSource, WorkerStatus as DashboardWorkerStatus,
} from "./dashboard/types.js";
```

(`WorkerStatus` is aliased to avoid colliding with the existing `WorkerStatus` export from `./types.js`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/shared/dashboard/client.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/dashboard/client.ts src/shared/dashboard/client.test.ts src/shared/index.ts
git commit -m "feat(shared): [DEN-2288] add best-effort dashboard HTTP client"
```

---

## Task 6: Task queue — add `trigger` and `attemptNumber`

**Files:**
- Modify: `src/manager/tasks.ts`
- Test: `src/manager/tasks.test.ts` (exists — add cases)

The scheduler computes the dispatch reason then discards it; thread it (and the attempt number) into the task so the run projection has them. `attemptNumber` is the count of prior tasks for that ticket + 1, computed inside `enqueue`.

- [ ] **Step 1: Write the failing test**

Add to `src/manager/tasks.test.ts` (it already constructs a `SqliteTaskQueue` via `createTaskQueueFromDatabaseUrl("sqlite::memory:")` — follow the existing setup in that file):

```ts
it("stamps trigger and a 1-based attemptNumber per ticket", async () => {
  const queue = createTaskQueueFromDatabaseUrl("sqlite::memory:");
  await queue.initialize();
  const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", pr: null, trigger: "new" });
  const second = await queue.enqueue({ state: "iteration", ticketId: "DEN-1", pr: { owner: "o", repo: "r", number: 3 }, trigger: "ci_failure" });
  const other = await queue.enqueue({ state: "new", ticketId: "DEN-2", pr: null, trigger: "new" });
  expect(first.attemptNumber).toBe(1);
  expect(first.input.trigger).toBe("new");
  expect(second.attemptNumber).toBe(2);
  expect(second.input.trigger).toBe("ci_failure");
  expect(other.attemptNumber).toBe(1);
  await queue.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manager/tasks.test.ts`
Expected: FAIL — `trigger`/`attemptNumber` not on the types.

- [ ] **Step 3: Implement**

In `src/manager/tasks.ts`:

1. Import the trigger type:
```ts
import type { DispatchResult, DispatchState, PullRequestRef } from "../worker/index.js";
import type { RunTrigger } from "../shared/index.js";
```

2. Extend `DispatchTaskInput`:
```ts
export interface DispatchTaskInput {
  state: DispatchState;
  ticketId: string;
  pr: PullRequestRef | null;
  trigger: RunTrigger;
}
```

3. Add `attemptNumber` to `TaskRecord` and `TaskRow`:
```ts
// in TaskRecord:
  attemptNumber: number;
// in TaskRow:
  attempt_number: number;
```

4. Add the column to BOTH `CREATE TABLE tasks` statements (SQLite and Postgres):
```sql
        attempt_number INTEGER NOT NULL,
```
(place it after `dispatch_state TEXT NOT NULL,`).

5. In both `enqueue` implementations, compute the attempt number and persist `trigger` (it already lives in `input_json`, so only `attempt_number` needs its own column). SQLite version:
```ts
  async enqueue(input: DispatchTaskInput): Promise<TaskRecord> {
    const db = this.requireDb();
    const id = randomUUID();
    const now = nowIso();
    const prior = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE ticket_id = ?").get(input.ticketId) as { c: number };
    const attemptNumber = prior.c + 1;
    db.prepare(`
      INSERT INTO tasks (
        id, ticket_id, dispatch_state, attempt_number, input_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.ticketId, input.state, attemptNumber, JSON.stringify(input), now, now);
    return rowToTask(this.getById(id));
  }
```
Postgres version mirrors this with `$n` params and `SELECT COUNT(*)::int`.

6. In `rowToTask`, add `attemptNumber: Number(row.attempt_number),`.

7. In `parseTaskInput`, parse the new field:
```ts
  return { state, ticketId, pr: parsePullRequestRef(parsed.pr), trigger: parseTrigger(parsed.trigger) };
```
and add:
```ts
function parseTrigger(value: unknown): RunTrigger {
  if (value === "new" || value === "ci_failure" || value === "delegated_back") return value;
  throw new Error(`Invalid run trigger: ${String(value)}`);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/manager/tasks.test.ts`
Expected: PASS. (Existing tests that call `enqueue` must be updated to pass `trigger`; update them to `trigger: "new"`.)

- [ ] **Step 5: Commit**

```bash
git add src/manager/tasks.ts src/manager/tasks.test.ts
git commit -m "feat(manager): [DEN-2288] track run trigger and attempt number on tasks"
```

---

## Task 7: DashboardReporter — lifecycle → rows/events

**Files:**
- Create: `src/manager/dashboardReporter.ts`
- Test: `src/manager/dashboardReporter.test.ts`

The single place that knows the `bm_status` mapping and event types. Methods are fire-and-forget (the client is already best-effort). It needs a clock injected (the repo bans ambient `Date.now()` in some contexts and it keeps tests deterministic).

`ticketRow(ticket, bmStatus, extras)` is a private helper building a `TicketPayload` from a Linear `Ticket` (which has `id, identifier, title, description, url, branchName, status {name,type}, labels`).

- [ ] **Step 1: Write the failing test**

```ts
// src/manager/dashboardReporter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../shared/index.js";
import type { DashboardClient } from "../shared/index.js";
import type { Ticket } from "../shared/index.js";
import { DashboardReporter } from "./dashboardReporter.js";

const logger = createLogger({ level: "silent", name: "test" });
function fakeClient() {
  return {
    upsertTicket: vi.fn().mockResolvedValue(undefined),
    upsertWorker: vi.fn().mockResolvedValue(undefined),
    upsertRun: vi.fn().mockResolvedValue(undefined),
    upsertPullRequest: vi.fn().mockResolvedValue(undefined),
    upsertCiRun: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  } satisfies DashboardClient;
}
const ticket: Ticket = {
  id: "lin_1", identifier: "DEN-1", title: "t", description: null, url: "u", branchName: "b",
  status: { name: "Todo", type: "unstarted" }, labels: ["bear-metal"], assignee: null, delegate: { id: "agent" },
};
const reporter = (c: DashboardClient) => new DashboardReporter({ client: c, logger, maxAttempts: 5, now: () => new Date(1000) });

describe("ticketDiscovered", () => {
  it("upserts the ticket as discovered and emits ticket_discovered", async () => {
    const c = fakeClient();
    await reporter(c).ticketDiscovered(ticket);
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ id: "lin_1", bmStatus: "discovered", labels: ["bear-metal"], maxAttempts: 5 }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "ticket_discovered", source: "manager", ticketId: "lin_1" }));
  });
});

describe("runStarted", () => {
  it("marks the run running and the ticket in_progress", async () => {
    const c = fakeClient();
    await reporter(c).runStarted({ ticket, runId: "run_1", workerId: "wk_1", attemptNumber: 1, trigger: "new" });
    expect(c.upsertRun).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1", status: "running", workerId: "wk_1", startedAt: 1000 }));
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "in_progress" }));
  });
});

describe("ciFailed", () => {
  it("sets ticket ci_failed and emits ci_failed", async () => {
    const c = fakeClient();
    await reporter(c).ciFailed(ticket, "tests failed");
    expect(c.upsertTicket).toHaveBeenCalledWith(expect.objectContaining({ bmStatus: "ci_failed" }));
    expect(c.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "ci_failed" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manager/dashboardReporter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/manager/dashboardReporter.ts
import type { DashboardClient, Logger, PullRequest, Ticket } from "../shared/index.js";
import type { BmStatus, RunTrigger } from "../shared/index.js";

export interface DashboardReporterDeps {
  client: DashboardClient;
  logger: Logger;
  maxAttempts: number;
  /** Injected clock — keeps writes deterministic in tests and avoids ambient Date.now(). */
  now?: () => Date;
}

export interface RunRef {
  ticket: Ticket;
  runId: string;
  workerId: string | null;
  attemptNumber: number;
  trigger: RunTrigger;
}

const prId = (pr: PullRequest): string => `${pr.owner}/${pr.repo}#${pr.number}`;

export class DashboardReporter {
  private readonly d: DashboardReporterDeps;
  private readonly now: () => Date;
  constructor(deps: DashboardReporterDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  private ms(): number { return this.now().getTime(); }

  private ticketPayload(ticket: Ticket, bmStatus: BmStatus, attemptCount: number, completedAt: number | null) {
    const t = this.ms();
    return {
      id: ticket.id, identifier: ticket.identifier, title: ticket.title, description: ticket.description,
      url: ticket.url, branchName: ticket.branchName, linearStatusName: ticket.status.name,
      linearStatusType: ticket.status.type, labels: ticket.labels, bmStatus,
      attemptCount, maxAttempts: this.d.maxAttempts, createdAt: t, updatedAt: t, completedAt,
    };
  }

  async ticketDiscovered(ticket: Ticket): Promise<void> {
    await this.d.client.upsertTicket(this.ticketPayload(ticket, "discovered", 0, null));
    await this.d.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "ticket_discovered", summary: `Discovered ${ticket.identifier}`, payloadJson: null, createdAt: this.ms() });
  }

  async runDispatched(ref: RunRef): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertRun({ id: ref.runId, ticketId: ref.ticket.id, attemptNumber: ref.attemptNumber, workerId: null, trigger: ref.trigger, status: "dispatched", contextJson: null, startedAt: null, endedAt: null, stopReason: null, error: null, createdAt: t });
    await this.d.client.upsertTicket(this.ticketPayload(ref.ticket, "dispatched", ref.attemptNumber, null));
    await this.d.client.recordEvent({ ticketId: ref.ticket.id, runId: ref.runId, workerId: null, source: "manager", type: "dispatched", summary: `Dispatched attempt ${ref.attemptNumber}`, payloadJson: null, createdAt: t });
  }

  async runStarted(ref: RunRef): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertRun({ id: ref.runId, ticketId: ref.ticket.id, attemptNumber: ref.attemptNumber, workerId: ref.workerId, trigger: ref.trigger, status: "running", contextJson: null, startedAt: t, endedAt: null, stopReason: null, error: null, createdAt: t });
    await this.d.client.upsertTicket(this.ticketPayload(ref.ticket, "in_progress", ref.attemptNumber, null));
  }

  async runSucceeded(ref: RunRef): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertRun({ id: ref.runId, ticketId: ref.ticket.id, attemptNumber: ref.attemptNumber, workerId: ref.workerId, trigger: ref.trigger, status: "succeeded", contextJson: null, startedAt: null, endedAt: t, stopReason: "completed", error: null, createdAt: t });
  }

  async runCrashed(ref: RunRef, error: string): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertRun({ id: ref.runId, ticketId: ref.ticket.id, attemptNumber: ref.attemptNumber, workerId: ref.workerId, trigger: ref.trigger, status: "crashed", contextJson: null, startedAt: null, endedAt: t, stopReason: "crash", error, createdAt: t });
    await this.d.client.recordEvent({ ticketId: ref.ticket.id, runId: ref.runId, workerId: ref.workerId, source: "worker", type: "worker_crashed", summary: error, payloadJson: null, createdAt: t });
  }

  async prOpened(ticket: Ticket, pr: PullRequest, runId: string): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertPullRequest({ id: prId(pr), ticketId: ticket.id, number: pr.number, title: pr.title, headRef: pr.headRef, state: pr.state, draft: pr.draft, merged: pr.merged, url: pr.url, lastRunId: runId, createdAt: t, updatedAt: t });
    await this.d.client.upsertTicket(this.ticketPayload(ticket, "pr_open", 0, null));
    await this.d.client.recordEvent({ ticketId: ticket.id, runId, workerId: null, source: "worker", type: "pr_opened", summary: `PR #${pr.number} opened`, payloadJson: null, createdAt: t });
  }

  async ciFailed(ticket: Ticket, summary: string): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertTicket(this.ticketPayload(ticket, "ci_failed", 0, null));
    await this.d.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "ci", type: "ci_failed", summary, payloadJson: null, createdAt: t });
  }

  async delegatedBack(ticket: Ticket, summary: string): Promise<void> {
    await this.d.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "delegated_back", summary, payloadJson: null, createdAt: this.ms() });
  }

  async ticketCompleted(ticket: Ticket): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertTicket(this.ticketPayload(ticket, "completed", 0, t));
    await this.d.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "ticket_completed", summary: `Completed ${ticket.identifier}`, payloadJson: null, createdAt: t });
  }

  async workerUpsert(workerId: string, name: string, status: "idle" | "busy", currentRunId: string | null, startedAt: number): Promise<void> {
    const t = this.ms();
    await this.d.client.upsertWorker({ id: workerId, name, status, currentRunId, lastHeartbeatAt: t, startedAt, updatedAt: t });
  }
}
```

Note: `attemptCount` on ticket-status updates other than dispatch is passed as `0` here for brevity — replace with the real attempt number where the caller has it (PR/CI/complete events don't carry it; the dashboard's authoritative attempt count comes from the `dispatched`/`running` writes, and `listTickets` derives the latest run separately). This is acceptable for phase 1; document it inline in the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/manager/dashboardReporter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manager/dashboardReporter.ts src/manager/dashboardReporter.test.ts
git commit -m "feat(manager): [DEN-2288] add DashboardReporter lifecycle projection"
```

---

## Task 8: Wire the reporter into the scheduler

**Files:**
- Modify: `src/manager/scheduler.ts`
- Test: `src/manager/scheduler.test.ts` (exists — extend)

Thread the trigger reason into dispatch and call the reporter at the transition points. The scheduler already has the data; add an optional `reporter` to `SchedulerDeps` so existing tests keep working without one.

- [ ] **Step 1: Add `reporter` to `SchedulerDeps`**

```ts
import type { DashboardReporter } from "./dashboardReporter.js";
// ...
export interface SchedulerDeps {
  // ...existing fields...
  reporter?: DashboardReporter;
}
```

- [ ] **Step 2: Carry the trigger on each dispatch decision**

Extend `TicketDecision` with `trigger: RunTrigger` (import `RunTrigger` from `../shared/index.js`). Set it in `evaluateTicket`/`decideForOpenPr`:
- parked / no-dispatch branches → `trigger: "new"` (unused when `dispatch:false`).
- admission (new ticket) → `"new"`.
- `decideForOpenPr`: `resuming` → `"delegated_back"`; else if `testsFailed` → `"ci_failure"`; else `"delegated_back"` (unresolved comments).

- [ ] **Step 3: Emit reporter calls**

- In `admitNewTickets`, after `store.upsert(...)` for each admitted ticket: `void deps.reporter?.ticketDiscovered(ticket);` (pass `reporter` into the helper, or inline the loop in `tick`).
- In `decideForOpenPr`, when `testsFailed`: `void reporter?.ciFailed(ticket, "CI checks failed on the PR head");` and when re-dispatching due to resume/unresolved comments: `void reporter?.delegatedBack(ticket, "Re-dispatched: unresolved review or resumed");`
- In `refreshTrackedTickets`, after a merged handBack: `void reporter?.ticketCompleted(ticket);`

Pass `trigger` through to the handler: change `TicketHandler.handle` to accept the trigger (Task 9 consumes it). Minimal approach — attach it to the dispatched context:

```ts
// dispatchTickets / runHandler signature gains `trigger`
const outcome = await handler.handle(context, decision.trigger);
```
(Track the trigger alongside each context in the `toDispatch` array, e.g. `{ context, trigger }`.)

- [ ] **Step 4: Update test**

Add a scheduler test that injects a fake reporter (same shape as Task 7's fake, but only the methods used) and asserts `ticketDiscovered` is called once for a newly admitted ticket. Follow the existing harness in `scheduler.test.ts` (it already builds fake `linear`/`github`/`store`/`tasks`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/manager/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/manager/scheduler.ts src/manager/scheduler.test.ts
git commit -m "feat(manager): [DEN-2288] report ticket/CI transitions to the dashboard"
```

---

## Task 9: Wire the reporter into the handler and worker

**Files:**
- Modify: `src/manager/ticket-handler.ts`, `src/worker/task-worker.ts`
- Test: `src/manager/ticket-handler.test.ts`, `src/worker/task-worker.test.ts` (extend)

### 9a — handler emits `dispatched` + the run row

- [ ] **Step 1:** Add optional `reporter?: DashboardReporter` and `maxAttempts`-free signature to `ManagerTicketHandlerDeps`. Change `handle(ctx, trigger: RunTrigger)`; after `enqueue`, call:

```ts
void this.reporter?.runDispatched({
  ticket: ctx.ticket, runId: task.id, workerId: null, attemptNumber: task.attemptNumber, trigger,
});
```

(`task.attemptNumber` now exists from Task 6. The `runId` is the task id — runs.id = task id, per spec §7.)

- [ ] **Step 2:** Update `ticket-handler.test.ts` to pass `trigger: "new"` and assert `runDispatched` fires when a reporter is injected.

### 9b — worker emits run started / succeeded / crashed / pr_opened + worker row

- [ ] **Step 3:** Add optional `reporter?: DashboardReporter` to `TaskWorkerDeps`. On `start()`, call `void this.reporter?.workerUpsert(this.workerId, hostname-ish-name, "idle", null, Date.now())` — capture `startedAt` once in the constructor as `this.startedAt = Date.now()` and the name as `${os.hostname()}/${process.pid}` (import `hostname` from `node:os`).

- [ ] **Step 4:** In `runTask`, the reporter needs the ticket's Linear **issue id**, but the task only has the ticket **identifier**. For phase 1, the worker has `task.input` (identifier + pr). The run row's `ticketId` must be the Linear issue id to match the `tickets` table. Resolve this by having the worker fetch the ticket via `this.integrations.linear.getTicketContext(task.ticketId)` is heavy; instead, **the manager already wrote the run row** (`runDispatched` in 9a) keyed by `runId=task.id` with the correct `ticketId`. So the worker only needs to update the run's **status/worker/timestamps** by `runId` — it does not need the ticket id. Add reporter methods that take an explicit `ticketId` string instead of a `Ticket`:

Add to `DashboardReporter` (Task 7 file) thin id-based variants used by the worker:

```ts
async runStartedById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger): Promise<void> {
  const t = this.ms();
  await this.d.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "running", contextJson: null, startedAt: t, endedAt: null, stopReason: null, error: null, createdAt: t });
}
async runSucceededById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger): Promise<void> {
  const t = this.ms();
  await this.d.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "succeeded", contextJson: null, startedAt: null, endedAt: t, stopReason: "completed", error: null, createdAt: t });
}
async runCrashedById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger, error: string): Promise<void> {
  const t = this.ms();
  await this.d.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "crashed", contextJson: null, startedAt: null, endedAt: t, stopReason: "crash", error, createdAt: t });
  await this.d.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "worker_crashed", summary: error, payloadJson: null, createdAt: t });
}
```

But the worker doesn't have the Linear issue id either — only the identifier. **Decision (phase 1):** the run row's `ticketId` is set authoritatively by the manager's `runDispatched` (9a). `upsertRun` from the worker would overwrite `ticketId`. To avoid the worker needing the issue id, change `upsertRun`'s worker-side calls to send the issue id that the manager passes **down through the task**: add `ticketIssueId` to `DispatchTaskInput` (Task 6 stored only identifier). Update Task 6 to also store `ticketIssueId` (the manager has it on `ctx.ticket.id` at enqueue). Then the worker reads `task.input.ticketIssueId`.

> **Plan note:** This couples back to Task 6 — when implementing, add `ticketIssueId: string` to `DispatchTaskInput` and set it in `ManagerTicketHandler.handle` from `ctx.ticket.id`. The reporter `*ById` methods then receive `task.input.ticketIssueId`.

- [ ] **Step 5:** In `runTask`, around the dispatch:

```ts
const { id: runId, ticketId: identifier, attemptNumber } = task;
const issueId = task.input.ticketIssueId;
const trigger = task.input.trigger;
void this.reporter?.runStartedById(runId, issueId, this.workerId, attemptNumber, trigger);
void this.reporter?.workerUpsert(this.workerId, this.workerName, "busy", runId, this.startedAt);
const result = await this.runDispatch({ ...task.input, integrations: this.integrations, packageRoot: this.packageRoot });
await this.tasks.complete(task.id, result);
void this.reporter?.runSucceededById(runId, issueId, this.workerId, attemptNumber, trigger);
if (result.pr) {
  void this.reporter?.recordPrOpenedById(issueId, result.pr, runId); // see note
}
void this.reporter?.workerUpsert(this.workerId, this.workerName, "idle", null, this.startedAt);
```

For `pr_opened` the worker has only a `PullRequestRef` (owner/repo/number), not the full `PullRequest`. Add a minimal id-based PR event to the reporter that records the event without the full PR row (the full PR row is written by the scheduler's `prOpened` on the next refresh when it fetches PR status):

```ts
async recordPrOpenedById(ticketId: string, pr: { owner: string; repo: string; number: number }, runId: string): Promise<void> {
  await this.d.client.recordEvent({ ticketId, runId, workerId: null, source: "worker", type: "pr_opened", summary: `PR #${pr.number} opened`, payloadJson: JSON.stringify(pr), createdAt: this.ms() });
}
```

- [ ] **Step 6:** In the `task-worker.ts` `.catch` for a failed task run, call `void this.reporter?.runCrashedById(task.id, task.input.ticketIssueId, this.workerId, task.attemptNumber, task.input.trigger, String(err));`. Note the task stays acquired/uncompleted today (a known gap); this only adds the crash projection, it does not change task-queue behavior.

- [ ] **Step 7:** Update `task-worker.test.ts` to inject a fake reporter and assert `runStartedById` + `runSucceededById` fire for a successful task.

- [ ] **Step 8:** Run tests.

Run: `npx vitest run src/manager/ticket-handler.test.ts src/worker/task-worker.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/manager/ticket-handler.ts src/worker/task-worker.ts src/manager/dashboardReporter.ts src/manager/tasks.ts src/manager/*.test.ts src/worker/*.test.ts
git commit -m "feat(manager): [DEN-2288] project run lifecycle + worker rows from the worker"
```

---

## Task 10: Construct + inject the client and reporter

**Files:**
- Modify: `src/manager/config.ts`, `src/manager/index.ts`

- [ ] **Step 1: Config**

In `src/manager/config.ts`, add to `Config`:
```ts
  dashboardUrl: string;
  ingestToken: string;
```
and in `loadConfig`:
```ts
    dashboardUrl: process.env.DASHBOARD_URL ?? "",
    ingestToken: process.env.INGEST_TOKEN ?? "",
```
(Empty `dashboardUrl` → reporter writes are skipped; see Step 2.)

- [ ] **Step 2: Wire in `index.ts`**

After `const tasks = ...`:
```ts
import { createDashboardClient } from "../shared/index.js";
import { DashboardReporter } from "./dashboardReporter.js";
// ...
const reporter = config.dashboardUrl
  ? new DashboardReporter({
      client: createDashboardClient({ baseUrl: config.dashboardUrl, token: config.ingestToken, logger }),
      logger,
      maxAttempts: config.workerConcurrency > 0 ? 5 : 5, // phase-1 display constant; cap not yet enforced (DEN-2288 §8)
    })
  : undefined;
```
Pass `reporter` into both `new Scheduler({ ..., reporter })` and `new TaskWorker({ ..., reporter })`, and into `new ManagerTicketHandler({ logger, tasks, reporter })`.

> **Plan note:** `maxAttempts` is a hardcoded phase-1 display constant (5). Replace with a real cap when phase 2 lands the attempt-limit feature.

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run`
Expected: PASS across the suite.

- [ ] **Step 4: Commit**

```bash
git add src/manager/config.ts src/manager/index.ts
git commit -m "feat(manager): [DEN-2288] construct and inject the dashboard reporter"
```

---

## Task 11: `progress` / `branch_created` events from dispatch (optional polish)

**Files:**
- Modify: `src/worker/dispatch.ts`, `src/worker/task-worker.ts`

`dispatch()` runs deep in the worker and currently has no reporter. Rather than thread the reporter into `dispatch`, emit the two coarse events from `task-worker.runTask` using the data it already has:
- `branch_created`: emit once when `task.input.state === "new"` right before calling `runDispatch` (a new-state dispatch creates the branch).
- `progress`: emit once when `runDispatch` resolves, before `complete`, summarizing `result.status`.

- [ ] **Step 1:** Add to the reporter:

```ts
async progressById(ticketId: string, runId: string, workerId: string, summary: string): Promise<void> {
  await this.d.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "progress", summary, payloadJson: null, createdAt: this.ms() });
}
async branchCreatedById(ticketId: string, runId: string, workerId: string, branchName: string): Promise<void> {
  await this.d.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "branch_created", summary: `Branch ${branchName}`, payloadJson: null, createdAt: this.ms() });
}
```

- [ ] **Step 2:** Call them in `runTask` (the branch name is `task.input` is not present; use the ticket identifier as the summary, e.g. `branch for ${identifier}` — the exact branch is created inside dispatch and not returned, so keep the summary coarse).

- [ ] **Step 3:** Extend `task-worker.test.ts` to assert a `progress` event fires on success.

- [ ] **Step 4:** Run tests + commit.

```bash
git add src/worker/task-worker.ts src/manager/dashboardReporter.ts src/worker/task-worker.test.ts
git commit -m "feat(worker): [DEN-2288] emit progress and branch_created events"
```

---

## Task 12: End-to-end smoke (manual, documented)

**Files:** none (verification only).

- [ ] **Step 1:** Create + migrate a scratch dashboard DB:

```bash
BEAR_METAL_DB_PATH=/tmp/dash.sqlite npx tsx -e "import Database from 'better-sqlite3'; import {drizzle} from 'drizzle-orm/better-sqlite3'; import {migrate} from 'drizzle-orm/better-sqlite3/migrator'; import * as s from './src/backend/db/schema.js'; const db=drizzle(new Database('/tmp/dash.sqlite'),{schema:s}); migrate(db,{migrationsFolder:'./src/backend/db/migrations'}); console.log('migrated');"
```

- [ ] **Step 2:** Run the backend with the write API on:

```bash
BEAR_METAL_DB_PATH=/tmp/dash.sqlite BACKEND_PORT=3100 INGEST_TOKEN=devtok npx tsx src/backend/index.ts
```

- [ ] **Step 3:** Confirm a write lands and reads back:

```bash
curl -s -X PUT localhost:3100/api/tickets/lin_smoke -H 'authorization: Bearer devtok' -H 'content-type: application/json' \
  -d '{"id":"lin_smoke","identifier":"DEN-SMOKE","title":"smoke","description":null,"url":"u","branchName":"b","linearStatusName":"Todo","linearStatusType":"unstarted","labels":["bear-metal"],"bmStatus":"discovered","attemptCount":0,"maxAttempts":5,"createdAt":1717000000000,"updatedAt":1717000000000,"completedAt":null}'
curl -s localhost:3100/api/tickets/lin_smoke | head -c 400
```
Expected: PUT returns 204; GET shows the ticket with `bmStatus: "discovered"`.

- [ ] **Step 4:** Confirm a missing token is rejected:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X PUT localhost:3100/api/tickets/lin_smoke -H 'content-type: application/json' -d '{}'
```
Expected: `401`.

---

## Self-review notes (resolved during planning)
- **Spec coverage:** write boundary (T1,3,4), client (T5), runs enrichment (T6,9), bm_status mapping (T7), events (T7,8,9,11), worker rows (T9), deferred items left unimplemented and noted (`maxAttempts` constant T10; no CI polling; no heartbeat beyond last-write; no PR timestamps). All spec §-items map to a task.
- **ID reconciliation:** runs/PRs/events use the Linear **issue id** as `ticketId`; since the task queue only stored the identifier, `ticketIssueId` is added to `DispatchTaskInput` in Task 6/9a so the worker can populate it. **When implementing, do Task 6 and Task 9's `ticketIssueId` addition together.**
- **Type consistency:** reporter method names (`ticketDiscovered`, `runDispatched`, `runStarted`/`runStartedById`, `runSucceeded`/`runSucceededById`, `runCrashed`/`runCrashedById`, `prOpened`/`recordPrOpenedById`, `ciFailed`, `delegatedBack`, `ticketCompleted`, `workerUpsert`, `progressById`, `branchCreatedById`) are used consistently across Tasks 7–11. Payload field names match `shared/dashboard/types.ts`.
- **Known phase-1 limitations carried as code comments:** `attemptCount` is `0` on non-dispatch ticket upserts; crashed tasks remain acquired in the queue (unchanged behavior); `ci_running`/`ci_passed`/`abandoned`/`worker_timeout` are never emitted.
