import { describe, expect, it } from "vitest";

import {
  createLogger,
  type PullRequest,
  type PullRequestRef,
  type PullRequestStatus,
  type Ticket,
  type TicketContext,
  type WorkOutcome,
} from "../shared/index.js";

import { Scheduler, type GitHubSource, type LinearSource, type TicketHandler } from "./scheduler.js";
import { TicketStore } from "./state.js";
import { makeContext, makeTicket } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });

function openPr(number = 7, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: "acme",
    repo: "widgets",
    number,
    title: "PR",
    headRef: "feature/a",
    state: "open",
    draft: false,
    merged: false,
    url: `https://github.com/acme/widgets/pull/${number}`,
    ...overrides,
  };
}

function status(pr: PullRequest, testsFailed = false, hasUnresolvedComments = false): PullRequestStatus {
  return { pr, testsFailed, hasUnresolvedComments };
}

class FakeLinear implements LinearSource {
  handBackCalls: string[] = [];
  constructor(
    private readonly todo: Ticket[],
    /** Override what getTicket returns per id (refresh sees a possibly-reassigned ticket). */
    private readonly refreshed: Record<string, Ticket> = {},
  ) {}
  async findDelegatedTickets(_agentId: string): Promise<Ticket[]> {
    return this.todo;
  }
  async getTicket(id: string): Promise<Ticket> {
    return this.refreshed[id] ?? this.todo.find((t) => t.id === id) ?? makeTicket(id);
  }
  async handBack(ticketId: string): Promise<void> {
    this.handBackCalls.push(ticketId);
  }
}

class FakeGitHub implements GitHubSource {
  findCalls: string[] = [];
  statusCalls: number[] = [];
  constructor(private readonly opts: { found?: PullRequest | null; status?: PullRequestStatus } = {}) {}
  async findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null> {
    this.findCalls.push(ticket.id);
    return this.opts.found ?? null;
  }
  async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    this.statusCalls.push(ref.number);
    return this.opts.status ?? status(openPr(ref.number));
  }
}

class FakeHandler implements TicketHandler {
  handled: TicketContext[] = [];
  constructor(private readonly outcome: WorkOutcome = { status: "pending" }) {}
  async handle(ctx: TicketContext): Promise<WorkOutcome> {
    this.handled.push(ctx);
    return this.outcome;
  }
}

function buildScheduler(deps: {
  linear: LinearSource;
  github: GitHubSource;
  store: TicketStore;
  handler: TicketHandler;
  concurrency: number;
}): Scheduler {
  return new Scheduler({
    logger,
    linear: deps.linear,
    github: deps.github,
    store: deps.store,
    handler: deps.handler,
    agentId: "user-1",
    concurrency: deps.concurrency,
    pollIntervalMs: 60_000,
  });
}

describe("Scheduler.tick", () => {
  it("admits at most `concurrency` tickets and dispatches new ones", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const handler = new FakeHandler();
    const scheduler = buildScheduler({ linear, github: new FakeGitHub(), store, handler, concurrency: 2 });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(2);
    expect(handler.handled).toHaveLength(2);
  });

  it("admits nothing new when slots are full", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(),
      store,
      handler: new FakeHandler(),
      concurrency: 2,
    });

    await scheduler.tick();
    await scheduler.stop();
    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(2);
  });

  it("does not query GitHub during admission, only when refreshing tracked tickets", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a")]);
    const github = new FakeGitHub();
    const scheduler = buildScheduler({ linear, github, store, handler: new FakeHandler(), concurrency: 1 });

    await scheduler.tick(); // admit "a" (new) — no GitHub call
    await scheduler.stop();
    expect(github.findCalls).toHaveLength(0);

    await scheduler.tick(); // refresh tracked "a" (still no PR) — searches for a PR
    await scheduler.stop();
    expect(github.findCalls).toEqual(["a"]);
  });

  it("releases a ticket when its PR is merged and hands it back to the assignee", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: openPr() });
    const github = new FakeGitHub({ status: status(openPr(7, { merged: true, state: "closed" })) });
    const linear = new FakeLinear([]); // ticket is no longer Todo, so it won't be re-admitted
    const scheduler = buildScheduler({
      linear,
      github,
      store,
      handler: new FakeHandler(),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(0);
    expect(linear.handBackCalls).toEqual(["a"]);
  });

  it("releases a ticket when its PR is closed unmerged without handing it back", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: openPr() });
    const github = new FakeGitHub({ status: status(openPr(7, { state: "closed" })) });
    const linear = new FakeLinear([]); // ticket is no longer Todo, so it won't be re-admitted
    const scheduler = buildScheduler({
      linear,
      github,
      store,
      handler: new FakeHandler(),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(0);
    expect(linear.handBackCalls).toEqual([]);
  });

  it("re-dispatches an iteration whose PR has failed tests", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: openPr() });
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([makeTicket("a")]),
      github: new FakeGitHub({ status: status(openPr(), true, false) }),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(1);
    expect(handler.handled.at(-1)?.ticket.id).toBe("a");
    expect(handler.handled.at(-1)?.pr?.number).toBe(7);
  });

  it("re-dispatches an iteration with unresolved review comments", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: openPr() });
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([makeTicket("a")]),
      github: new FakeGitHub({ status: status(openPr(), false, true) }),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
  });

  it("parks a tracked ticket whose delegation was relinquished, without dispatching or hitting GitHub", async () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a")); // delegated to me, no PR, phase active
    const reassigned = makeTicket("a", { delegate: { id: "someone-else" } });
    const github = new FakeGitHub();
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { a: reassigned }),
      github,
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(store.count()).toBe(1);
    expect(store.get("a")?.phase).toBe("parked");
    expect(github.findCalls).toHaveLength(0);
    expect(github.statusCalls).toHaveLength(0);
  });

  it("keys on delegate, not assignee: parks a ticket assigned to the agent but delegated elsewhere", async () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a")); // delegated to me, phase active
    // assignee is the agent id, but delegate is someone else — a buggy assignee-keyed gate
    // would treat this as "mine" and dispatch; the correct delegate-keyed gate parks it.
    const refreshed = makeTicket("a", { assignee: { id: "user-1" }, delegate: { id: "someone-else" } });
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { a: refreshed }),
      github: new FakeGitHub(),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(store.get("a")?.phase).toBe("parked");
  });

  it("resumes a parked ticket when it is reassigned back to the manager", async () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"), "parked"); // was parked, no PR
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { a: makeTicket("a") }), // back to me (default assignee user-1)
      github: new FakeGitHub({ found: null }),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled.map((c) => c.ticket.id)).toEqual(["a"]);
    expect(store.get("a")?.phase).toBe("active");
    expect(store.count()).toBe(1);
  });

  it("does not re-dispatch a no-PR active ticket on refresh (dispatch is edge-triggered)", async () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a")); // mine, no PR, phase active
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { a: makeTicket("a") }),
      github: new FakeGitHub({ found: null }),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(store.count()).toBe(1);
    expect(store.get("a")?.phase).toBe("active");
  });

  it("does not re-dispatch a clean, open, unmerged iteration", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: openPr() });
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear: new FakeLinear([makeTicket("a")]),
      github: new FakeGitHub({ status: status(openPr(), false, false) }),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(1);
    expect(handler.handled).toHaveLength(0);
  });
});
