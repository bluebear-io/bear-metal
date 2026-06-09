import { describe, expect, it } from "vitest";

import {
  createLogger,
  type FindTicketsOptions,
  type PullRequest,
  type Ticket,
  type TicketContext,
  type WorkOutcome,
} from "../shared/index.js";

import { Scheduler, type GitHubSource, type LinearSource, type TicketHandler } from "./scheduler.js";
import { TicketStore } from "./state.js";
import { makeTicket } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });

class FakeLinear implements LinearSource {
  getTicketIds: string[] = [];
  constructor(private readonly todo: Ticket[]) {}
  async findTicketsByAssignee(_assigneeId: string, _options?: FindTicketsOptions): Promise<Ticket[]> {
    return this.todo;
  }
  async getTicket(id: string): Promise<Ticket> {
    this.getTicketIds.push(id);
    return this.todo.find((t) => t.id === id) ?? makeTicket(id);
  }
}

class FakeGitHub implements GitHubSource {
  lookups: string[] = [];
  constructor(private readonly pr: PullRequest | null = null) {}
  async findPullRequestForTicket(ticket: Ticket): Promise<PullRequest | null> {
    this.lookups.push(ticket.id);
    return this.pr;
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
    assigneeId: "user-1",
    concurrency: deps.concurrency,
    pollIntervalMs: 60_000,
  });
}

const PR: PullRequest = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "PR",
  headRef: "feature/a",
  state: "open",
  draft: false,
  merged: false,
  url: "https://github.com/acme/widgets/pull/7",
};

describe("Scheduler.tick", () => {
  it("admits at most `concurrency` tickets assigned to the user", async () => {
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

    expect(store.count()).toBe(2);
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
    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(2);
  });

  it("queries GitHub only for active tickets (never for fresh admissions)", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b")]);
    const github = new FakeGitHub(PR);
    const scheduler = buildScheduler({
      linear,
      github,
      store,
      handler: new FakeHandler(),
      concurrency: 2,
    });

    await scheduler.tick();
    expect(github.lookups).toHaveLength(0);

    await scheduler.tick();
    await scheduler.stop();
    expect(github.lookups.sort()).toEqual(["a", "b"]);
  });

  it("hands the handler the merged ticket + PR context", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a")]);
    const handler = new FakeHandler();
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(PR),
      store,
      handler,
      concurrency: 1,
    });

    await scheduler.tick(); // admit "a", dispatch with pr: null
    await scheduler.stop(); // drain so the ticket is no longer in flight
    await scheduler.tick(); // refresh "a" → pr: PR, dispatch again
    await scheduler.stop();

    expect(handler.handled.at(-1)?.ticket.id).toBe("a");
    expect(handler.handled.at(-1)?.pr).toEqual(PR);
  });

  it("records a pending dispatch and keeps the ticket", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(null),
      store,
      handler: new FakeHandler({ status: "pending" }),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(1);
    expect(store.get("a")?.status).toBe("pending");
  });

  it("removes a ticket only when a done dispatch is an iteration", async () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: PR }); // iteration
    const linear = new FakeLinear([makeTicket("a")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(PR),
      store,
      handler: new FakeHandler({ status: "done" }),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(0);
  });

  it("keeps a done dispatch that is still new (no PR)", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(null),
      store,
      handler: new FakeHandler({ status: "done" }),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.count()).toBe(1);
    expect(store.get("a")?.status).toBe("done");
    expect(store.get("a")?.state).toBe("new");
  });
});
