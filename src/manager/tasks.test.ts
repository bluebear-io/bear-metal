import { afterEach, describe, expect, it } from "vitest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { createTaskQueueFromDatabaseUrl, type TaskQueue } from "./tasks.js";

const queues: TaskQueue[] = [];

async function makeQueue(): Promise<TaskQueue> {
  const queue = createTaskQueueFromDatabaseUrl("sqlite::memory:");
  await queue.initialize();
  queues.push(queue);
  return queue;
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
});

describe("TaskQueue", () => {
  it("enqueues and atomically acquires one task", async () => {
    const queue = await makeQueue();
    const input = { state: "new" as const, ticketId: "DEN-1", prs: [], trigger: "new" as const, ticketIssueId: "lin_0" };

    const task = await queue.enqueue(input);
    expect(task.ticketId).toBe("DEN-1");
    expect(task.dispatchState).toBe("new");
    expect(task.workerId).toBeNull();
    expect(task.resultStatus).toBeNull();
    expect(task.slotStatus).toBe("active");
    expect(task.releasedAt).toBeNull();
    expect(task.input).toEqual(input);

    const acquired = await queue.acquireNext("worker-1");
    expect(acquired?.id).toBe(task.id);
    expect(acquired?.workerId).toBe("worker-1");
    expect(acquired?.input).toEqual(input);

    await expect(queue.acquireNext("worker-2")).resolves.toBeNull();
  });

  it("records dispatch result JSON on completed tasks", async () => {
    const queue = await makeQueue();
    const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });

    await queue.acquireNext("worker-1");
    await queue.complete(first.id, {
      status: "done",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
    });

    const [slot] = await queue.listTracked();
    expect(slot?.latestTask.id).toBe(first.id);
    expect(slot?.latestTask.resultStatus).toBe("done");
    expect(slot?.latestTask.result).toEqual({
      status: "done",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
    });
  });

  it("stamps trigger and a 1-based attemptNumber per ticket", async () => {
    const queue = createTaskQueueFromDatabaseUrl("sqlite::memory:");
    await queue.initialize();
    const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const second = await queue.enqueue({ state: "iteration", ticketId: "DEN-1", prs: [{ owner: "o", repo: "r", number: 3 }], trigger: "ci_failure", ticketIssueId: "lin_1" });
    const other = await queue.enqueue({ state: "new", ticketId: "DEN-2", prs: [], trigger: "new", ticketIssueId: "lin_2" });
    expect(first.attemptNumber).toBe(1);
    expect(first.input.trigger).toBe("new");
    expect(first.input.ticketIssueId).toBe("lin_1");
    expect(second.attemptNumber).toBe(2);
    expect(second.input.trigger).toBe("ci_failure");
    expect(other.attemptNumber).toBe(1);
    await queue.close();
  });

  it("tracks the latest unreleased task row per ticket as a manager slot", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const latest = await queue.enqueue({
      state: "iteration",
      ticketId: "DEN-1",
      prs: [{ owner: "bluebear-io", repo: "bear-metal", number: 5 }],
      trigger: "ci_failure",
      ticketIssueId: "lin_1",
    });

    const tracked = await queue.listTracked();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.ticketId).toBe("DEN-1");
    expect(tracked[0]?.latestTask.id).toBe(latest.id);
    expect(await queue.countTracked()).toBe(1);
  });

  it("assigns iteration_number=1 on the first task and increments on re-dispatch for the same ticket", async () => {
    const queue = await makeQueue();
    const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    expect(first.iterationNumber).toBe(1);

    const second = await queue.enqueue({ state: "iteration", ticketId: "DEN-1", prs: [], trigger: "delegated_back", ticketIssueId: "lin_1" });
    expect(second.iterationNumber).toBe(2);

    const otherTicket = await queue.enqueue({ state: "new", ticketId: "DEN-2", prs: [], trigger: "new", ticketIssueId: "lin_2" });
    expect(otherTicket.iterationNumber).toBe(1);
  });

  it("reports iteration counts via getIterationCount", async () => {
    const queue = await makeQueue();
    expect(await queue.getIterationCount("DEN-unknown")).toBe(0);

    await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    expect(await queue.getIterationCount("DEN-1")).toBe(1);

    await queue.enqueue({ state: "iteration", ticketId: "DEN-1", prs: [], trigger: "delegated_back", ticketIssueId: "lin_1" });
    await queue.enqueue({ state: "iteration", ticketId: "DEN-1", prs: [], trigger: "delegated_back", ticketIssueId: "lin_1" });
    expect(await queue.getIterationCount("DEN-1")).toBe(3);
    expect(await queue.getIterationCount("DEN-2")).toBe(0);
  });

  it("parks, resumes, and releases a ticket slot by updating the latest task row", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });

    const parked = await queue.setSlotStatus("DEN-1", "parked");
    expect(parked.id).toBe(task.id);
    expect(parked.slotStatus).toBe("parked");
    expect(parked.releasedAt).toBeNull();
    await expect(queue.acquireNext("worker-1")).resolves.toBeNull();

    const active = await queue.setSlotStatus("DEN-1", "active");
    expect(active.slotStatus).toBe("active");
    expect((await queue.acquireNext("worker-1"))?.id).toBe(task.id);

    const released = await queue.setSlotStatus("DEN-1", "released");
    expect(released.slotStatus).toBe("released");
    expect(released.releasedAt).toBeInstanceOf(Date);
    expect(await queue.countTracked()).toBe(0);
  });

  it("stamps lastHeartbeatAt when a worker acquires a task", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    expect(task.lastHeartbeatAt).toBeNull();

    const acquired = await queue.acquireNext("worker-1");
    expect(acquired?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it("heartbeat refreshes lastHeartbeatAt for the owning worker", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const acquired = await queue.acquireNext("worker-1");
    const first = acquired!.lastHeartbeatAt!;

    await sleep(5);
    await queue.heartbeat(task.id, "worker-1");
    const refreshed = (await queue.listTracked())[0]?.latestTask.lastHeartbeatAt;
    expect(refreshed).toBeInstanceOf(Date);
    expect(refreshed!.getTime()).toBeGreaterThan(first.getTime());
  });

  it("heartbeat is a no-op when the worker_id does not match", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const acquired = await queue.acquireNext("worker-1");
    const first = acquired!.lastHeartbeatAt!;

    await sleep(5);
    await queue.heartbeat(task.id, "worker-other");
    const refreshed = (await queue.listTracked())[0]?.latestTask.lastHeartbeatAt;
    expect(refreshed!.getTime()).toBe(first.getTime());
  });

  it("recoverStaleTasks releases acquired tasks past the threshold and leaves fresh ones alone", async () => {
    const queue = await makeQueue();
    const stale = await queue.enqueue({ state: "new", ticketId: "DEN-stale", prs: [], trigger: "new", ticketIssueId: "lin_s" });
    const fresh = await queue.enqueue({ state: "new", ticketId: "DEN-fresh", prs: [], trigger: "new", ticketIssueId: "lin_f" });
    await queue.acquireNext("worker-A"); // claims `stale` (FIFO by created_at)
    await sleep(20);
    await queue.acquireNext("worker-B"); // claims `fresh`

    // Threshold of 10ms: `stale` was acquired ~20ms ago, `fresh` just now.
    const recovered = await queue.recoverStaleTasks(10);
    expect(recovered).toEqual([stale.id]);

    // Recovered row is back in the pool and can be re-acquired.
    const reacquired = await queue.acquireNext("worker-C");
    expect(reacquired?.id).toBe(stale.id);
    expect(reacquired?.workerId).toBe("worker-C");

    // The fresh task stays with worker-B.
    const freshSlot = (await queue.listTracked()).find((s) => s.ticketId === "DEN-fresh");
    expect(freshSlot?.latestTask.workerId).toBe("worker-B");
    expect(freshSlot?.latestTask.id).toBe(fresh.id);
  });

  it("recoverStaleTasks never resets completed tasks", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const acquired = await queue.acquireNext("worker-1");
    await queue.complete(task.id, {
      status: "done",
      prs: [{ owner: "o", repo: "r", number: 1 }],
    });
    await sleep(20);

    const recovered = await queue.recoverStaleTasks(0);
    expect(recovered).toEqual([]);

    const slot = (await queue.listTracked())[0];
    expect(slot?.latestTask.workerId).toBe(acquired!.workerId);
    expect(slot?.latestTask.resultStatus).toBe("done");
  });

  it("recoverStaleTasks never clears worker_id on released slots (so in-flight worker.complete() still works)", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    await queue.acquireNext("worker-1");
    // Scheduler releases the slot mid-flight (e.g. PR merged externally before the worker returns).
    await queue.setSlotStatus("DEN-1", "released");
    await sleep(20);

    const recovered = await queue.recoverStaleTasks(10);
    expect(recovered).toEqual([]);

    // worker-1 must still be able to complete — recovery must not have nulled worker_id.
    await expect(
      queue.complete(task.id, { status: "done", prs: [] }),
    ).resolves.toBeUndefined();
  });

  it("recoverStaleTasks recovers acquired rows with NULL lastHeartbeatAt (pre-heartbeat rows)", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    await queue.acquireNext("worker-1");
    // Simulate a row written before the heartbeat column existed: clear last_heartbeat_at directly.
    // SqliteTaskQueue is private, so reach through `unknown` to its db handle just for this fixture.
    const db = (queue as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL WHERE id = ?").run(task.id);

    const recovered = await queue.recoverStaleTasks(60_000);
    expect(recovered).toEqual([task.id]);
  });
});
