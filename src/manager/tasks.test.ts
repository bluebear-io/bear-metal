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
    expect(task.input).toEqual(input);

    const acquired = await queue.acquireNext("worker-1");
    expect(acquired?.id).toBe(task.id);
    expect(acquired?.workerId).toBe("worker-1");
    expect(acquired?.input).toEqual(input);

    await expect(queue.acquireNext("worker-2")).resolves.toBeNull();
  });

  it("records dispatch result JSON and returns completed tracked tasks", async () => {
    const queue = await makeQueue();
    const first = await queue.enqueue({ state: "new", ticketId: "DEN-1", pr: null });
    const second = await queue.enqueue({ state: "new", ticketId: "DEN-2", pr: null });

    await queue.acquireNext("worker-1");
    await queue.complete(first.id, {
      status: "done",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
    });

    const completed = await queue.getCompleted([first.id, second.id]);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.id).toBe(first.id);
    expect(completed[0]?.resultStatus).toBe("done");
    expect(completed[0]?.result).toEqual({
      status: "done",
      pr: { owner: "bluebear-io", repo: "bear-metal", number: 5 },
    });
  });
});
