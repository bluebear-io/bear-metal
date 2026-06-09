import { describe, expect, it, vi } from "vitest";

import { createLogger, type WorkerResponse } from "../shared/index.js";

import { ManagerTicketHandler } from "./ticket-handler.js";
import { makeContext } from "./test-helpers.js";

const logger = createLogger({ level: "silent", name: "test" });

describe("ManagerTicketHandler", () => {
  it("reports a pending dispatch as pending (not as done)", async () => {
    const worker = vi.fn(async (): Promise<WorkerResponse> => ({ status: "pending" }));
    const handler = new ManagerTicketHandler({ logger, worker });
    const ctx = makeContext("den-1");

    const outcome = await handler.handle(ctx);

    expect(worker).toHaveBeenCalledWith(ctx);
    expect(outcome.status).toBe("pending");
  });

  it("reports a done dispatch as done", async () => {
    const worker = vi.fn(async (): Promise<WorkerResponse> => ({ status: "done" }));
    const handler = new ManagerTicketHandler({ logger, worker });

    const outcome = await handler.handle(makeContext("den-2"));

    expect(outcome.status).toBe("done");
  });
});
