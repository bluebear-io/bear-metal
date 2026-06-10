import { describe, it, expect, vi } from "vitest";
import { createDashboardClient } from "./client.js";
import { createLogger } from "../logger.js";

const logger = createLogger({ level: "silent", name: "test" });
const ticket = {
  id: "lin_x", identifier: "DEN-X", title: "t", description: null, url: "u", branchName: "b",
  linearStatusName: "Todo", linearStatusType: "unstarted", labels: [], bmStatus: "discovered" as const,
  attemptCount: 0, maxAttempts: 5, createdAt: 1, updatedAt: 1, completedAt: null,
};

describe("createDashboardClient", () => {
  it("PUTs to the right URL with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    const client = createDashboardClient({ baseUrl: "http://host:3100", token: "tok", logger, fetchImpl });
    await client.upsertTicket(ticket);
    expect(fetchImpl).toHaveBeenCalledWith("http://host:3100/api/tickets/lin_x", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ authorization: "Bearer tok", "content-type": "application/json" }),
      body: JSON.stringify(ticket),
    }));
  });

  it("swallows a non-ok response (best-effort, never throws)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as unknown as Response);
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    await expect(client.upsertTicket(ticket)).resolves.toBeUndefined();
  });

  it("swallows a network throw (best-effort, never throws)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    await expect(client.recordEvent({ ticketId: null, runId: null, workerId: null, source: "manager", type: "progress", summary: "x", payloadJson: null, createdAt: 1 })).resolves.toBeUndefined();
  });
});
