import { afterEach, describe, expect, it } from "vitest";

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
import { makeTicket } from "./test-helpers.js";
import { createTaskQueueFromDatabaseUrl, type DispatchTaskInput, type TaskQueue } from "./tasks.js";

const logger = createLogger({ level: "silent", name: "test" });
const queues: TaskQueue[] = [];

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

function prRef(number = 7): PullRequestRef {
  return { owner: "acme", repo: "widgets", number };
}

function status(pr: PullRequest, testsFailed = false, hasActionableUnresolvedComments = false): PullRequestStatus {
  return { pr, testsFailed, hasActionableUnresolvedComments };
}

async function makeQueue(): Promise<TaskQueue> {
  const queue = createTaskQueueFromDatabaseUrl("sqlite::memory:");
  await queue.initialize();
  queues.push(queue);
  return queue;
}

async function seedCompletedTask(
  tasks: TaskQueue,
  input: DispatchTaskInput,
  result: { status: "pending" | "done"; pr: PullRequestRef | null },
): Promise<void> {
  const task = await tasks.enqueue(input);
  const acquired = await tasks.acquireNext("worker-1");
  expect(acquired?.id).toBe(task.id);
  await tasks.complete(task.id, result);
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
});

class FakeLinear implements LinearSource {
  handBackCalls: string[] = [];
  constructor(
    private readonly todo: Ticket[],
    /** Override what getTicket returns per id or identifier. */
    private readonly refreshed: Record<string, Ticket> = {},
  ) {}
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
}

class FakeGitHub implements GitHubSource {
  statusCalls: number[] = [];
  constructor(private readonly opts: { status?: PullRequestStatus } = {}) {}
  async getPullRequestStatus(ref: PullRequestRef): Promise<PullRequestStatus> {
    this.statusCalls.push(ref.number);
    return this.opts.status ?? status(openPr(ref.number));
  }
}

class RecordingHandler implements TicketHandler {
  handled: TicketContext[] = [];
  constructor(private readonly tasks: TaskQueue) {}
  async handle(ctx: TicketContext): Promise<WorkOutcome> {
    this.handled.push(ctx);
    const task = await this.tasks.enqueue({
      state: ctx.pr === null ? "new" : "iteration",
      ticketId: ctx.ticket.identifier,
      pr: ctx.pr ? { owner: ctx.pr.owner, repo: ctx.pr.repo, number: ctx.pr.number } : null,
    });
    return { status: "pending", taskId: task.id };
  }
}

function buildScheduler(deps: {
  linear: LinearSource;
  github: GitHubSource;
  tasks: TaskQueue;
  handler: TicketHandler;
  concurrency: number;
}): Scheduler {
  return new Scheduler({
    logger,
    linear: deps.linear,
    github: deps.github,
    tasks: deps.tasks,
    handler: deps.handler,
    agentId: "user-1",
    concurrency: deps.concurrency,
    pollIntervalMs: 60_000,
  });
}

describe("Scheduler.tick", () => {
  it("admits at most `concurrency` tickets and dispatches new ones into SQL tasks", async () => {
    const tasks = await makeQueue();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({ linear, github: new FakeGitHub(), tasks, handler, concurrency: 2 });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(2);
    expect(handler.handled).toHaveLength(2);
  });

  it("uses the worker-returned PR as the only known PR source for later iterations", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(7), true, false) }),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(handler.handled[0]?.pr).toEqual(openPr(7));
    const [slot] = await tasks.listTracked();
    expect(slot?.latestTask.input).toEqual({ state: "iteration", ticketId: "A", pr: prRef(7) });
  });

  it("admits nothing new when SQL slots are full", async () => {
    const tasks = await makeQueue();
    const linear = new FakeLinear([makeTicket("a"), makeTicket("b"), makeTicket("c")]);
    const scheduler = buildScheduler({
      linear,
      github: new FakeGitHub(),
      tasks,
      handler: new RecordingHandler(tasks),
      concurrency: 2,
    });

    await scheduler.tick();
    await scheduler.stop();
    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(2);
  });

  it("does not query GitHub for no-PR tickets after admission", async () => {
    const tasks = await makeQueue();
    const linear = new FakeLinear([makeTicket("a")], { A: makeTicket("a") });
    const github = new FakeGitHub();
    const scheduler = buildScheduler({ linear, github, tasks, handler: new RecordingHandler(tasks), concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();
    await scheduler.tick();
    await scheduler.stop();

    expect(github.statusCalls).toHaveLength(0);
  });

  it("releases a ticket when its known PR is merged and hands it back to the assignee", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const github = new FakeGitHub({ status: status(openPr(7, { merged: true, state: "closed" })) });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const scheduler = buildScheduler({
      linear,
      github,
      tasks,
      handler: new RecordingHandler(tasks),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual(["a"]);
  });

  it("releases a ticket when its known PR is closed unmerged without handing it back", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const github = new FakeGitHub({ status: status(openPr(7, { state: "closed" })) });
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const scheduler = buildScheduler({
      linear,
      github,
      tasks,
      handler: new RecordingHandler(tasks),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(0);
    expect(linear.handBackCalls).toEqual([]);
  });

  it("re-dispatches an iteration whose known PR has failed tests", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), true, false) }),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(1);
    expect(handler.handled.at(-1)?.ticket.id).toBe("a");
    expect(handler.handled.at(-1)?.pr?.number).toBe(7);
  });

  it("re-dispatches an iteration with actionable unresolved review comments", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), false, true) }),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
  });

  it("does not re-dispatch an iteration whose unresolved threads are all from bear-metal (waiting on human)", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      // hasActionableUnresolvedComments: false — latest comment is from bear-metal, waiting on human
      github: new FakeGitHub({ status: status(openPr(), false, false) }),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
  });

  it("parks a tracked ticket whose delegation was relinquished, without dispatching or hitting GitHub", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "pending", pr: null });
    const reassigned = makeTicket("a", { delegate: { id: "someone-else" } });
    const github = new FakeGitHub();
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: reassigned }),
      github,
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    const [slot] = await tasks.listTracked();
    expect(handler.handled).toHaveLength(0);
    expect(await tasks.countTracked()).toBe(1);
    expect(slot?.slotStatus).toBe("parked");
    expect(github.statusCalls).toHaveLength(0);
  });

  it("keys on delegate, not assignee: parks a ticket assigned to the agent but delegated elsewhere", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "pending", pr: null });
    const refreshed = makeTicket("a", { assignee: { id: "user-1" }, delegate: { id: "someone-else" } });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: refreshed }),
      github: new FakeGitHub(),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    const [slot] = await tasks.listTracked();
    expect(handler.handled).toHaveLength(0);
    expect(slot?.slotStatus).toBe("parked");
  });

  it("resumes a parked ticket when it is reassigned back to the manager", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "pending", pr: null });
    await tasks.setSlotStatus("A", "parked");
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub(),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    const [slot] = await tasks.listTracked();
    expect(handler.handled.map((c) => c.ticket.id)).toEqual(["a"]);
    expect(slot?.slotStatus).toBe("active");
    expect(await tasks.countTracked()).toBe(1);
  });

  it("does not re-dispatch a no-PR active ticket on refresh", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "pending", pr: null });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub(),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    const [slot] = await tasks.listTracked();
    expect(handler.handled).toHaveLength(0);
    expect(await tasks.countTracked()).toBe(1);
    expect(slot?.slotStatus).toBe("active");
  });

  it("does not re-dispatch a clean, open, unmerged iteration", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a") }),
      github: new FakeGitHub({ status: status(openPr(), false, false) }),
      tasks,
      handler,
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(1);
    expect(handler.handled).toHaveLength(0);
  });

  it("releases terminal Linear tickets even when no PR is known", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "pending", pr: null });
    const terminal = makeTicket("a", { status: { name: "Done", type: "completed" } });
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: terminal }),
      github: new FakeGitHub(),
      tasks,
      handler: new RecordingHandler(tasks),
      concurrency: 1,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(await tasks.countTracked()).toBe(0);
  });

  it("hands back and releases tickets that have reached the iteration limit", async () => {
    const tasks = await makeQueue();
    for (let i = 0; i < 20; i++) {
      await seedCompletedTask(
        tasks,
        { state: "new", ticketId: "A", pr: null },
        { status: "done", pr: prRef(7) },
      );
    }
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({ status: status(openPr(7), true, false) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({ linear, github, tasks, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(0);
    expect(linear.commentAndHandBackCalls).toHaveLength(1);
    expect(linear.commentAndHandBackCalls[0]?.ticketId).toBe("a");
    expect(linear.commentAndHandBackCalls[0]?.body).toContain("maximum iteration limit of 20");
    expect(await tasks.countTracked()).toBe(0);
  });

  it("dispatches normally for tickets below the iteration limit", async () => {
    const tasks = await makeQueue();
    for (let i = 0; i < 5; i++) {
      await seedCompletedTask(
        tasks,
        { state: "new", ticketId: "A", pr: null },
        { status: "done", pr: prRef(7) },
      );
    }
    const linear = new FakeLinear([], { A: makeTicket("a") });
    const github = new FakeGitHub({ status: status(openPr(7), true, false) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({ linear, github, tasks, handler, concurrency: 1 });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled).toHaveLength(1);
    expect(linear.commentAndHandBackCalls).toEqual([]);
  });

  it("logs and skips a completed done task with no PR while continuing other tracked slots", async () => {
    const tasks = await makeQueue();
    await seedCompletedTask(tasks, { state: "new", ticketId: "A", pr: null }, { status: "done", pr: null });
    await seedCompletedTask(tasks, { state: "new", ticketId: "B", pr: null }, { status: "done", pr: prRef(7) });
    const handler = new RecordingHandler(tasks);
    const scheduler = buildScheduler({
      linear: new FakeLinear([], { A: makeTicket("a"), B: makeTicket("b") }),
      github: new FakeGitHub({ status: status(openPr(7), true, false) }),
      tasks,
      handler,
      concurrency: 2,
    });

    await scheduler.tick();
    await scheduler.stop();

    expect(handler.handled.map((ctx) => ctx.ticket.identifier)).toEqual(["B"]);
    expect(await tasks.countTracked()).toBe(2);
  });
});
