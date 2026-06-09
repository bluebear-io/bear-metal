import { afterEach, describe, expect, it } from "vitest";

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
    const input = { state: "new" as const, ticketId: "DEN-1", pr: null };

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
    const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", pr: null });

    await queue.acquireNext("worker-1");
    await queue.complete(first.id, {
      status: "done",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
    });

    const [slot] = await queue.listTracked();
    expect(slot?.latestTask.id).toBe(first.id);
    expect(slot?.latestTask.resultStatus).toBe("done");
    expect(slot?.latestTask.result).toEqual({
      status: "done",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
    });
  });

  it("tracks the latest unreleased task row per ticket as a manager slot", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ state: "new", ticketId: "DEN-1", pr: null });
    const latest = await queue.enqueue({
      state: "iteration",
      ticketId: "DEN-1",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
    });

    const tracked = await queue.listTracked();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.ticketId).toBe("DEN-1");
    expect(tracked[0]?.latestTask.id).toBe(latest.id);
    expect(await queue.countTracked()).toBe(1);
  });

  it("parks, resumes, and releases a ticket slot by updating the latest task row", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", pr: null });

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
});
