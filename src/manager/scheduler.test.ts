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
  async findTicketsByLabel(_label: string, _options?: FindTicketsOptions): Promise<Ticket[]> {
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
  constructor(private readonly outcome: WorkOutcome = { done: false }) {}
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
    label: "bear-metal",
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
  it("admits at most `concurrency` Todo tickets", async () => {
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

    expect(store.activeCount()).toBe(2);
  });

  it("admits nothing new when slots are full", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const handler = new FakeHandler();
    const scheduler = buildScheduler({ linear, github: new FakeGitHub(), store, handler, concurrency: 2 });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.stop();

    expect(store.activeCount()).toBe(2);
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

    // First tick: no active tickets yet → no GitHub lookups, just admissions.
    await scheduler.tick();
    expect(github.lookups).toHaveLength(0);

    // Second tick: the two now-active tickets are refreshed against GitHub.
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

  it("frees the slot when the handler reports done", async () => {
    const store = new TicketStore();
    const linear = new FakeLinear([makeTicket("a")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(),
      store,
      handler: new FakeHandler({ done: true }),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(store.activeCount()).toBe(0);
  });
});
