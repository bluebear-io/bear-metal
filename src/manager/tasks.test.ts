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

  it("records worker_heartbeat_at on acquire and refreshes it via heartbeat()", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const acquired = await queue.acquireNext("worker-1");
    expect(acquired?.workerHeartbeatAt).toBeInstanceOf(Date);
    const firstHeartbeat = acquired!.workerHeartbeatAt!.getTime();

    await new Promise((r) => setTimeout(r, 10));
    await expect(queue.heartbeat(task.id, "worker-1")).resolves.toBe(true);

    const [slot] = await queue.listTracked();
    expect(slot?.latestTask.workerHeartbeatAt!.getTime()).toBeGreaterThan(firstHeartbeat);

    // Foreign worker can't refresh; the lease lookup must reject it.
    await expect(queue.heartbeat(task.id, "worker-other")).resolves.toBe(false);
  });

  it("reclaims an acquired task whose heartbeat is stale by releasing worker_id for re-acquire", async () => {
    // Reproduces DEN-2334: worker_id IS NOT NULL, result_status IS NULL, stale updated_at.
    // Without recovery acquireNext() returns null and the ticket is stuck forever.
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    const acquired = await queue.acquireNext("worker-1");
    expect(acquired?.id).toBe(task.id);

    // Confirm the stuck-state invariant: no further acquisition possible.
    await expect(queue.acquireNext("worker-2")).resolves.toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    const recovered = await queue.reclaimStaleTasks({ staleAfterMs: 1, maxReclaims: 3 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.action).toBe("reclaimed");
    expect(recovered[0]?.previousWorkerId).toBe("worker-1");
    expect(recovered[0]?.task.workerId).toBeNull();
    expect(recovered[0]?.task.reclaimCount).toBe(1);
    expect(recovered[0]?.task.workerHeartbeatAt).toBeNull();
    expect(recovered[0]?.task.resultStatus).toBeNull();

    // The row is now re-acquirable by another worker — the stuck state is gone.
    const reAcquired = await queue.acquireNext("worker-2");
    expect(reAcquired?.id).toBe(task.id);
    expect(reAcquired?.workerId).toBe("worker-2");
    expect(reAcquired?.reclaimCount).toBe(1);
  });

  it("skips reclaiming a task whose heartbeat is fresh", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    await queue.acquireNext("worker-1");
    const recovered = await queue.reclaimStaleTasks({ staleAfterMs: 60_000, maxReclaims: 3 });
    expect(recovered).toEqual([]);
  });

  it("abandons a task whose reclaim_count has reached the cap (terminal pending + slot released)", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });

    // First reclaim (reclaim_count 0 -> 1) under cap=2 still reclaims.
    await queue.acquireNext("worker-1");
    await new Promise((r) => setTimeout(r, 5));
    const first = await queue.reclaimStaleTasks({ staleAfterMs: 1, maxReclaims: 2 });
    expect(first[0]?.action).toBe("reclaimed");
    expect(first[0]?.task.reclaimCount).toBe(1);

    // Second reclaim would push reclaim_count to 2 == cap, so abandon.
    await queue.acquireNext("worker-2");
    await new Promise((r) => setTimeout(r, 5));
    const second = await queue.reclaimStaleTasks({ staleAfterMs: 1, maxReclaims: 2 });
    expect(second[0]?.action).toBe("abandoned");
    expect(second[0]?.previousWorkerId).toBe("worker-2");
    expect(second[0]?.task.resultStatus).toBe("pending");
    expect(second[0]?.task.slotStatus).toBe("released");
    expect(second[0]?.task.releasedAt).toBeInstanceOf(Date);

    // Slot is released; nothing tracked, nothing acquirable.
    expect(await queue.countTracked()).toBe(0);
    await expect(queue.acquireNext("worker-3")).resolves.toBeNull();
  });

  it("markCrashed releases the row immediately under the cap and abandons it at the cap", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    await queue.acquireNext("worker-1");

    const released = await queue.markCrashed(task.id, "worker-1", 3);
    expect(released?.action).toBe("reclaimed");
    expect(released?.task.workerId).toBeNull();

    // Re-acquire then crash twice more to hit the cap.
    await queue.acquireNext("worker-2");
    await queue.markCrashed(task.id, "worker-2", 3);
    await queue.acquireNext("worker-3");
    const abandoned = await queue.markCrashed(task.id, "worker-3", 3);
    expect(abandoned?.action).toBe("abandoned");
    expect(abandoned?.task.slotStatus).toBe("released");
  });

  it("markCrashed returns null when the row is not owned by the calling worker", async () => {
    const queue = await makeQueue();
    const task = await queue.enqueue({ state: "new", ticketId: "DEN-1", prs: [], trigger: "new", ticketIssueId: "lin_1" });
    await queue.acquireNext("worker-1");
    await expect(queue.markCrashed(task.id, "worker-other", 3)).resolves.toBeNull();
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

});
