import { describe, expect, it, vi } from "vitest";

import { createLogger, type WorkerResponse } from "../shared/index.js";

import { ManagerTicketHandler } from "./ticket-handler.js";
import { makeContext } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("ManagerTicketHandler", () => {
  it("delegates to the worker with the full context and keeps the ticket on noop", async () => {
    const worker = vi.fn(async (): Promise<WorkerResponse> => ({ status: "noop" }));
    const handler = new ManagerTicketHandler({ logger, worker });
    const ctx = makeContext("den-1");

    const outcome = await handler.handle(ctx);

    expect(worker).toHaveBeenCalledWith(ctx);
    expect(outcome.done).toBe(false);
  });

  it("frees the ticket when the worker reports a non-noop status", async () => {
    // The only WorkerStatus today is "noop"; simulate a future terminal status.
    const worker = vi.fn(async (): Promise<WorkerResponse> => ({ status: "done" } as unknown as WorkerResponse));
    const handler = new ManagerTicketHandler({ logger, worker });

    const outcome = await handler.handle(makeContext("den-2"));

    expect(outcome.done).toBe(true);
  });
});
