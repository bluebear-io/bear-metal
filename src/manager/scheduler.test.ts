import { afterEach, describe, expect, it } from "vitest";

import {
  createLogger,
  type JsonValue,
  type PullRequest,
  type PullRequestRef,
  type PullRequestStatus,
  type RunTrigger,
  type Ticket,
  type TicketContext,
  type WorkOutcome,
} from "../shared/index.js";

import { SqlDbClient, type DbClient, type DispatchTaskInput } from "../db/client.js";
import { Scheduler, type GitHubSource, type LinearSource, type TicketHandler } from "./scheduler.js";
import { makeTicket } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });
const dbs: DbClient[] = [];

function openPr(number = 7, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: "acme",
    repo: "widgets",
    number,
    title: "PR",
    headRef: "feature/a",
    headSha: `sha-${number}`,
    state: "open",
    draft: false,
    merged: false,
    url: `https://github.com/acme/widgets/pull/${number}`,
    ...overrides,
  };
}

function prRef(number = 7): PullRequestRef {
  return { owner: "acme", repo: "widgets", number };
}

function status(
  pr: PullRequest,
  testsFailed = false,
  hasActionableUnresolvedComments = false,
  humanTookOver = false,
  hasMergeConflicts = false,
  hasActionableIssueComments = false,
): PullRequestStatus {
  return {
    pr,
    testsFailed,
    hasActionableUnresolvedComments,
    hasActionableIssueComments,
    hasMergeConflicts,
    humanTookOver,
    context: {
      pullRequest: { head: { sha: "deadbeef" } } as unknown as JsonValue,
      headSha: "deadbeef",
      failedCheckRuns: [],
      failedStatuses: [],
      unresolvedReviewThreads: [],
      reviewThreads: [],
      issueComments: [],
      mergeable: hasMergeConflicts ? false : true,
    },
  };
}

async function makeDb(): Promise<DbClient> {
  const db = new SqlDbClient("sqlite::memory:");
  await db.initSchema();
  dbs.push(db);
  return db;
}

async function seedCompletedTask(
  db: DbClient,
  input: Pick<DispatchTaskInput, "state" | "ticketId" | "prs">,
  result: { status: "pending" | "done"; prs: PullRequestRef[] },
): Promise<void> {
  const task = await db.enqueue({ ...input, trigger: "new", ticketIssueId: input.ticketId.toLowerCase() });
  const acquired = await db.acquireNext("worker-1");
  expect(acquired?.id).toBe(task.id);
  await db.complete(task.id, result);
}

afterEach(async () => {
  await Promise.all(dbs.splice(0).map((db) => db.close()));
});

class FakeLinear implements LinearSource {
  handBackCalls: string[] = [];
  constructor(
    private readonly todo: Ticket[],
    /** Override what getTicket returns per id or identifier. */
    private readonly refreshed: Record<string, Ticket> = {},
  ) {}
  async getAgentId(): Promise<string> {
    return "user-1";
  }
  async findDelegatedTickets(_agentId: string): Promise<Ticket[]> {
    return this.todo;
  }
  async getTicket(id: string): Promise<Ticket> {
    return (
      this.refreshed[id] ??
      this.refreshed[id.toLowerCase()] ??
      this.refreshed[id.toUpperCase()] ??
      this.todo.find((ticket) => ticket.id === id || ticket.identifier === id) ??
      makeTicket(id.toLowerCase())
    );
  }
  async handBack(ticketId: string): Promise<void> {
    this.handBackCalls.push(ticketId);
  }
  commentAndHandBackCalls: Array<{ ticketId: string; body: string }> = [];
  async commentAndHandBack(ticketId: string, body: string): Promise<void> {
    this.commentAndHandBackCalls.push({ ticketId, body });
  }
  async getUserEmail(_userId: string): Promise<string | null> {
    return null;
  }
}

class FakeGitHub implements GitHubSource {
  statusCalls: number[] = [];
  prCommentCalls: Array<{ ref: PullRequestRef; body: string }> = [];
  constructor(
    private readonly opts: {
      status?: PullRequestStatus;
      statusByNumber?: Record<number, PullRequestStatus>;
    } = {},
  ) {}
  async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    this.statusCalls.push(ref.number);
    const perPr = this.opts.statusByNumber?.[ref.number];
    if (perPr) return perPr;
    return this.opts.status ?? status(openPr(ref.number));
  }
  async leaveComment(ref: PullRequestRef, body: string): Promise<void> {
    this.prCommentCalls.push({ ref, body });
  }
  existingMarkers: Set<string> = new Set();
  hasMarkerCalls: Array<{ ref: PullRequestRef; marker: string }> = [];
  async hasIssueCommentWithMarker(ref: PullRequestRef, marker: string): Promise<boolean> {
    this.hasMarkerCalls.push({ ref, marker });
    return this.existingMarkers.has(`${ref.number}:${marker}`);
  }
}

class RecordingHandler implements TicketHandler {
  handled: TicketContext[] = [];
  triggers: RunTrigger[] = [];
  constructor(private readonly db: DbClient) {}
  async handle(ctx: TicketContext, trigger: RunTrigger): Promise<WorkOutcome> {
    this.handled.push(ctx);
    this.triggers.push(trigger);
    const task = await this.db.enqueue({
      state: ctx.prs.length === 0 ? "new" : "iteration",
      ticketId: ctx.ticket.identifier,
      prs: ctx.prs.map((pr) => ({ owner: pr.owner, repo: pr.repo, number: pr.number })),
      trigger,
      ticketIssueId: ctx.ticket.id,
    });
    return { status: "pending", taskId: task.id };
  }
}

function buildScheduler(deps: {
  linear: LinearSource;
  github: GitHubSource;
  db: DbClient;
  handler: TicketHandler;
  concurrency: number;
  taskStaleAfterMs?: number;
  taskMaxReclaims?: number;
}): Scheduler {
  return new Scheduler({
    logger,
    linear: deps.linear,
    github: deps.github,
    db: deps.db,
    handler: deps.handler,
    concurrency: deps.concurrency,
    pollIntervalMs: 60_000,
    taskStaleAfterMs: deps.taskStaleAfterMs,
    taskMaxReclaims: deps.taskMaxReclaims,
  });
}

describe("Scheduler.tick stale-task recovery (DEN-2334)", () => {
  it("reclaims an acquired task whose worker stopped heartbeating so the slot doesn't stay stuck", async () => {
    const db = await makeDb();
    // Simulate a worker that crashed mid-run: row has worker_id IS NOT NULL, result_status IS NULL,
    // and worker_heartbeat_at older than the stale threshold.
    const ticket = makeTicket("a");
    await db.enqueue({ state: "new", ticketId: ticket.identifier, prs: [], trigger: "new", ticketIssueId: ticket.id });
    await db.acquireNext("dead-worker");
    // Before recovery the row is unrecoverable through acquireNext().
    expect(await db.acquireNext("other-worker")).toBeNull();

    await new Promise((r) => setTimeout(r, 5));

    const linear = new FakeLinear([], { [ticket.id]: ticket });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(),
      db,
      handler,
      concurrency: 1,
      taskStaleAfterMs: 1,
      taskMaxReclaims: 3,
    });

    await scheduler.tick();
    await scheduler.stop();

    // After tick, the stuck row is released and re-acquirable by a live worker.
    const reAcquired = await db.acquireNext("live-worker");
    expect(reAcquired?.workerId).toBe("live-worker");
    expect(reAcquired?.reclaimCount).toBe(1);
  });
});

describe("Scheduler.tick", () => {
  it("admits at most `concurrency` tickets and dispatches new ones into SQL tasks", async () => {
    const db = await makeDb();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github: new FakeGitHub(), db, handler, concurrency: 2 });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(2);
    expect(handler.handled).toHaveLength(2);
  });

  it("admits higher-priority tickets first when concurrency is limited", async () => {
    const db = await makeDb();
    // Linear may return tickets in any order; prove the scheduler reorders by priority
    // before applying the concurrency cap. Urgent (1) and High (2) must win the two slots
    // over Low (4) and No Priority (0).
    const linear = new FakeLinear([
      makeTicket("low", { priority: 4 }),
      makeTicket("none", { priority: 0 }),
      makeTicket("urgent", { priority: 1 }),
      makeTicket("high", { priority: 2 }),
    ]);
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github: new FakeGitHub(), db, handler, concurrency: 2 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled.map((c) => c.ticket.id)).toEqual(["urgent", "high"]);
    expect(await db.countTracked()).toBe(2);
  });

  it("uses the worker-returned PR as the only known PR source for later iterations", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(7), true, false) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(handler.handled[0]?.prs).toEqual([prRef(7)]);
    const [slot] = await db.listTracked();
    expect(slot?.latestTask.input).toEqual({
      state: "iteration",
      ticketId: "A",
      prs: [prRef(7)],
      trigger: "ci_failure",
      ticketIssueId: "a",
    });
  });

  it("re-dispatches a PR with merge conflicts using the merge_conflict trigger", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      // testsFailed=false, hasActionableUnresolvedComments=false, humanTookOver=false,
      // hasMergeConflicts=true — conflicts alone must trigger a re-dispatch with the new trigger.
      github: new FakeGitHub({ status: status(openPr(7), false, false, false, true) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(handler.triggers).toEqual(["merge_conflict"]);
  });

  it("admits nothing new when SQL slots are full", async () => {
    const db = await makeDb();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(),
      db,
      handler: new RecordingHandler(db),
      concurrency: 2,
    });

    await scheduler.tick();
    await scheduler.stop();
    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(2);
  });

  it("does not query GitHub for no-PR tickets after admission", async () => {
    const db = await makeDb();
    const linear = new FakeLinear([makeTicket("a")], { A: makeTicket("a") });
    const github = new FakeGitHub();
    const scheduler = buildScheduler({ linear, github, db, handler: new RecordingHandler(db), concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();
    await scheduler.tick();
    await scheduler.stop();

    expect(github.statusCalls).toHaveLength(0);
  });

  it("releases a ticket when its known PR is merged and hands it back to the assignee", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const github = new FakeGitHub({ status: status(openPr(7, { merged: true, state: "closed" })) });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const scheduler = buildScheduler({
      linear,
      github,
      db,
      handler: new RecordingHandler(db),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual(["a"]);
  });

  it("releases a ticket when its known PR is closed unmerged without handing it back", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const github = new FakeGitHub({ status: status(openPr(7, { state: "closed" })) });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const scheduler = buildScheduler({
      linear,
      github,
      db,
      handler: new RecordingHandler(db),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual([]);
  });

  it("hands back a ticket when a human pushed a commit after bear-metal on an open PR", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({
      // testsFailed=true and hasActionableUnresolvedComments=true would normally re-dispatch —
      // humanTookOver must short-circuit that and release the slot instead.
      status: status(openPr(7), true, true, true),
    });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github, db, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(await db.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual([]);
    expect(linear.commentAndHandBackCalls).toHaveLength(1);
    expect(linear.commentAndHandBackCalls[0]?.ticketId).toBe("a");
    expect(linear.commentAndHandBackCalls[0]?.body).toMatch(/human takeover/i);
    expect(github.prCommentCalls).toHaveLength(1);
    expect(github.prCommentCalls[0]?.ref).toEqual(prRef(7));
    expect(github.prCommentCalls[0]?.body).toContain("bear-metal:human-takeover");
  });

  it("skips re-posting the human-takeover comment when the marker is already on the PR", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({ status: status(openPr(7), false, false, true) });
    github.existingMarkers.add("7:<!-- bear-metal:human-takeover -->");
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github, db, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(github.prCommentCalls).toHaveLength(0);
    // Linear handoff still runs so the ticket gets released even if the PR comment was already posted on a prior attempt.
    expect(linear.commentAndHandBackCalls).toHaveLength(1);
    expect(await db.countTracked()).toBe(0);
  });

  it("re-dispatches an iteration whose known PR has failed tests", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), true, false) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(1);
    expect(handler.handled.at(-1)?.ticket.id).toBe("a");
    expect(handler.handled.at(-1)?.prs[0]?.number).toBe(7);
  });

  it("re-dispatches an iteration with actionable unresolved review comments", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), false, true) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
  });

  it("does not re-dispatch an iteration whose unresolved threads are all from bear-metal (waiting on human)", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      // hasActionableUnresolvedComments: false — latest comment is from bear-metal, waiting on human
      github: new FakeGitHub({ status: status(openPr(), false, false) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
  });

  it("releases a tracked ticket whose worker handed it back (pending + delegation dropped)", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "pending", prs: [] });
    const reassigned = makeTicket("a", { delegate: { id: "someone-else" } });
    const github = new FakeGitHub();
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: reassigned }),
      github,
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(await db.countTracked()).toBe(0);
    expect(github.statusCalls).toHaveLength(0);
  });

  it("keys on delegate, not assignee: releases a pending ticket assigned to the agent but delegated elsewhere", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "pending", prs: [] });
    const refreshed = makeTicket("a", { assignee: { id: "user-1" }, delegate: { id: "someone-else" } });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: refreshed }),
      github: new FakeGitHub(),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(await db.countTracked()).toBe(0);
  });

  it("does not re-dispatch a no-PR active ticket on refresh", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "pending", prs: [] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub(),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    const [slot] = await db.listTracked();
    expect(handler.handled).toHaveLength(0);
    expect(await db.countTracked()).toBe(1);
    expect(slot?.slotStatus).toBe("active");
  });

  it("does not re-dispatch a clean, open, unmerged iteration", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), false, false) }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(1);
    expect(handler.handled).toHaveLength(0);
  });

  it("releases terminal Linear tickets even when no PR is known", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "pending", prs: [] });
    const terminal = makeTicket("a", { status: { name: "Done", type: "completed" } });
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: terminal }),
      github: new FakeGitHub(),
      db,
      handler: new RecordingHandler(db),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(0);
  });

  it("hands back and releases tickets that have reached the iteration limit", async () => {
    const db = await makeDb();
    for (let i = 0; i < 20; i++) {
      await seedCompletedTask(
        db,
        { state: "new", ticketId: "A", prs: [] },
        { status: "done", prs: [prRef(7)] },
      );
    }
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({ status: status(openPr(7), true, false) });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github, db, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(linear.commentAndHandBackCalls).toHaveLength(1);
    expect(linear.commentAndHandBackCalls[0]?.ticketId).toBe("a");
    expect(linear.commentAndHandBackCalls[0]?.body).toContain("maximum iteration limit of 20");
    expect(await db.countTracked()).toBe(0);
  });

  it("dispatches normally for tickets below the iteration limit", async () => {
    const db = await makeDb();
    for (let i = 0; i < 5; i++) {
      await seedCompletedTask(
        db,
        { state: "new", ticketId: "A", prs: [] },
        { status: "done", prs: [prRef(7)] },
      );
    }
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({ status: status(openPr(7), true, false) });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({ linear, github, db, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(linear.commentAndHandBackCalls).toEqual([]);
  });

  it("logs and skips a completed done task with no PR while continuing other tracked slots", async () => {
    const db = await makeDb();
    await seedCompletedTask(db, { state: "new", ticketId: "A", prs: [] }, { status: "done", prs: [] });
    await seedCompletedTask(db, { state: "new", ticketId: "B", prs: [] }, { status: "done", prs: [prRef(7)] });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a"), B: makeTicket("b") }),
      github: new FakeGitHub({ status: status(openPr(7), true, false) }),
      db,
      handler,
      concurrency: 2,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled.map((ctx) => ctx.ticket.identifier)).toEqual(["B"]);
    expect(await db.countTracked()).toBe(2);
  });

  it("re-dispatches a ticket with multiple known PRs when any has failing tests", async () => {
    const db = await makeDb();
    await seedCompletedTask(
      db,
      { state: "new", ticketId: "A", prs: [] },
      { status: "done", prs: [prRef(7), prRef(8)] },
    );
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({
        statusByNumber: {
          7: status(openPr(7), true, false),
          8: status(openPr(8), false, false),
        },
      }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(handler.handled[0]?.prs).toEqual([prRef(7), prRef(8)]);
    expect(await db.countTracked()).toBe(1);
  });

  it("releases a ticket with multiple known PRs only when all are merged or closed", async () => {
    const db = await makeDb();
    await seedCompletedTask(
      db,
      { state: "new", ticketId: "A", prs: [] },
      { status: "done", prs: [prRef(7), prRef(8)] },
    );
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const handler = new RecordingHandler(db);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub({
        statusByNumber: {
          7: status(openPr(7, { merged: true, state: "closed" })),
          // PR 8 still open — ticket must NOT be released yet.
          8: status(openPr(8)),
        },
      }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await db.countTracked()).toBe(1);
    expect(linear.handBackCalls).toEqual([]);

    // Now both PRs are merged — ticket should be released and handed back.
    const scheduler2 = buildScheduler({
      linear,
      github: new FakeGitHub({
        statusByNumber: {
          7: status(openPr(7, { merged: true, state: "closed" })),
          8: status(openPr(8, { merged: true, state: "closed" })),
        },
      }),
      db,
      handler,
      concurrency: 1,
    });

    await scheduler2.tick();
    await scheduler2.stop();

    expect(await db.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual(["a"]);
  });
});
