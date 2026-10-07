import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqlDbClient, type BmStatus, type DispatchTaskInput, type TicketInput } from "./client.js";

const dbPaths: string[] = [];
describe("worker lease fencing", () => {
  it("rejects a previous lease when the same worker reacquires the task", async () => {
    const db = await makeDb();
    try {
      const task = await db.enqueue({ state: "new", ticketId: "ABC-1", ticketIssueId: "lin_1", prs: [], trigger: "new" });
      const first = await db.acquireNext("worker");
      await db.markCrashed(task.id, "worker", 3);
      const second = await db.acquireNext("worker");
      expect(await db.heartbeat(task.id, "worker", first!.reclaimCount)).toBe(false);
      await expect(db.complete(task.id, { status: "done", prs: [] }, "worker", first!.reclaimCount)).rejects.toThrow();
      expect(await db.heartbeat(task.id, "worker", second!.reclaimCount)).toBe(true);
      await db.complete(task.id, { status: "done", prs: [] }, "worker", second!.reclaimCount);
    } finally {
      await db.close();
    }
  });
  it("rejects completion from the worker replaced after a reclaim", async () => {
    const db = await makeDb();
    try {
      const task = await db.enqueue({ state: "new", ticketId: "ABC-1", ticketIssueId: "lin_1", prs: [], trigger: "new" });
      await db.acquireNext("old-worker");
      await db.markCrashed(task.id, "old-worker", 3);
      const replacement = await db.acquireNext("new-worker");
      expect(replacement?.id).toBe(task.id);
      await expect(db.complete(task.id, { status: "done", prs: [] }, "old-worker")).rejects.toThrow("Cannot complete task");
      await db.complete(task.id, { status: "pending", prs: [] }, "new-worker");
    } finally {
      await db.close();
    }
  });
});
type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown[]>;

async function makeDb(): Promise<SqlDbClient> {
  const dir = await mkdtemp(join(tmpdir(), "bear-metal-db-"));
  dbPaths.push(dir);
  const db = new SqlDbClient(`sqlite:${join(dir, "test.sqlite")}`, 5);
  await db.initSchema();
  return db;
}

function makeTicket(id: string, identifier: string): TicketInput {
  return {
    id,
    identifier,
    title: `Ticket ${identifier}`,
    description: `Description ${identifier}`,
    url: `https://linear.app/example/issue/${identifier}`,
    branchName: `feature/${identifier.toLowerCase()}`,
    linearStatusName: "In Progress",
    linearStatusType: "started",
    labels: [],
  };
}

async function addTicket(db: SqlDbClient, id: string, identifier: string, status: BmStatus = "in_progress") {
  await db.upsertTicketDiscovered(makeTicket(id, identifier));
  await db.setTicketStatus(id, status);
}

async function addRun(db: SqlDbClient, ticketIssueId: string, ticketId: string, workerId: string, stopReason?: "completed" | "crash") {
  const input: DispatchTaskInput = {
    state: "new",
    ticketId,
    prs: [],
    trigger: "new",
    ticketIssueId,
  };
  const task = await db.enqueue(input);
  await db.upsertRunStarted(task.id, workerId, new Date("2026-06-09T10:00:00.000Z").toISOString());
  if (stopReason === "completed") {
    await db.upsertRunSucceeded(task.id, null);
    await db.complete(task.id, { status: "done", prs: [] });
  } else if (stopReason === "crash") {
    await db.upsertRunCrashed(task.id, "worker crashed");
    await db.complete(task.id, { status: "pending", prs: [] });
  }
}

describe("SqlDbClient listTickets", () => {
  afterEach(async () => {
    await Promise.all(dbPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("paginates one latest row per ticket instead of task rows", async () => {
    const db = await makeDb();
    try {
      await addTicket(db, "lin_1", "ABC-1");
      await addRun(db, "lin_1", "ABC-1", "worker-1");
      await addRun(db, "lin_1", "ABC-1", "worker-1");
      await addTicket(db, "lin_2", "ABC-2");
      await addRun(db, "lin_2", "ABC-2", "worker-2");
      await addTicket(db, "lin_3", "ABC-3");
      await addRun(db, "lin_3", "ABC-3", "worker-3");

      const queries: string[] = [];
      const originalQuery = (db as unknown as { query: QueryFn }).query.bind(db);
      (db as unknown as { query: QueryFn }).query = async (sql, params) => {
        queries.push(sql);
        return originalQuery(sql, params);
      };

      const firstPage = await db.listTickets({ page: 1, pageSize: 2 });
      const secondPage = await db.listTickets({ page: 2, pageSize: 2 });

      expect(queries.some((sql) => sql.includes("LIMIT ?"))).toBe(true);
      expect(queries.some((sql) => sql.includes("OFFSET ?"))).toBe(true);
      expect(firstPage.total).toBe(3);
      expect(firstPage.items).toHaveLength(2);
      expect(new Set(firstPage.items.map((item) => item.ticketId)).size).toBe(2);
      expect(secondPage.items).toHaveLength(1);
      expect([...firstPage.items, ...secondPage.items].map((item) => item.ticketId).sort()).toEqual(["lin_1", "lin_2", "lin_3"]);

      const outOfRangePage = await db.listTickets({ page: 3, pageSize: 2 });
      expect(outOfRangePage.total).toBe(3);
      expect(outOfRangePage.items).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("applies run filters before counting and paginating tickets", async () => {
    const db = await makeDb();
    try {
      await addTicket(db, "lin_1", "ABC-1");
      await addRun(db, "lin_1", "ABC-1", "worker-1", "completed");
      await addTicket(db, "lin_2", "ABC-2");
      await addRun(db, "lin_2", "ABC-2", "worker-2", "crash");
      await addTicket(db, "lin_3", "ABC-3");
      await addRun(db, "lin_3", "ABC-3", "worker-1", "completed");

      const result = await db.listTickets({ workerIds: ["worker-1"], stopReasons: ["completed"], page: 1, pageSize: 1 });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.latestRun?.workerId).toBe("worker-1");
      expect(result.items[0]?.latestRun?.stopReason).toBe("completed");
    } finally {
      await db.close();
    }
  });

  it("returns every pull request for each listed ticket", async () => {
    const db = await makeDb();
    try {
      await addTicket(db, "lin_1", "ABC-1");
      await addRun(db, "lin_1", "ABC-1", "worker-1", "completed");
      await db.upsertPullRequest("acme/api#101", "lin_1", {
        number: 101,
        title: "Backend",
        headRef: "feature/abc-1-api",
        state: "open",
        draft: false,
        merged: false,
        url: "https://github.com/acme/api/pull/101",
        lastRunId: null,
        reviewThreadsJson: "[]",
      });
      await db.upsertPullRequest("acme/ui#102", "lin_1", {
        number: 102,
        title: "Frontend",
        headRef: "feature/abc-1-ui",
        state: "closed",
        draft: false,
        merged: true,
        url: "https://github.com/acme/ui/pull/102",
        lastRunId: null,
        reviewThreadsJson: "[]",
      });

      const result = await db.listTickets({ page: 1, pageSize: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.pullRequests).toEqual([
        {
          id: "acme/ui#102",
          number: 102,
          title: "Frontend",
          headRef: "feature/abc-1-ui",
          url: "https://github.com/acme/ui/pull/102",
          state: "closed",
          draft: false,
          merged: true,
        },
        {
          id: "acme/api#101",
          number: 101,
          title: "Backend",
          headRef: "feature/abc-1-api",
          url: "https://github.com/acme/api/pull/101",
          state: "open",
          draft: false,
          merged: false,
        },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("SqlDbClient PR notification claims", () => {
  it("lets only one owner claim a task/PR send until it is released, delivered, or its lease expires", async () => {
    const db = await makeDb();
    const first = await db.claimPrNotifications("task-1", ["acme/widgets#7", "acme/widgets#8"], 60_000);
    expect(first.claimed).toEqual(["acme/widgets#7", "acme/widgets#8"]);
    expect((await db.claimPrNotifications("task-1", ["acme/widgets#7"], 60_000)).claimed).toEqual([]);

    await db.releasePrNotificationClaim("task-1", "acme/widgets#7", "someone-else");
    expect((await db.claimPrNotifications("task-1", ["acme/widgets#7"], 60_000)).claimed).toEqual([]);
    await db.releasePrNotificationClaim("task-1", "acme/widgets#7", first.claimToken);
    const retry = await db.claimPrNotifications("task-1", ["acme/widgets#7"], 60_000);
    expect(retry.claimed).toEqual(["acme/widgets#7"]);

    expect((await db.claimPrNotifications("task-1", ["acme/widgets#8"], 0)).claimed).toEqual(["acme/widgets#8"]);

    await db.markPrNotificationDelivered("task-1", "acme/widgets#7");
    expect((await db.claimPrNotifications("task-1", ["acme/widgets#7"], 0)).claimed).toEqual([]);
    expect(await db.listDeliveredPrNotifications("task-1")).toEqual(new Set(["acme/widgets#7"]));
    expect((await db.claimPrNotifications("task-2", ["acme/widgets#7"], 60_000)).claimed).toEqual(["acme/widgets#7"]);
    await db.close();
  });
});
