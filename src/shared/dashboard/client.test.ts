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

  it("posts bulk replacement for CI checks under the run-scoped URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    const checks = [{ id: "k1", ciRunId: "ci_1", source: "check_run" as const, externalId: "99", name: "ESLint", conclusion: "failure", detailsUrl: null, summary: null, annotationsJson: "[]", createdAt: 1 }];
    await client.replaceCiChecks("ci_1", checks);
    expect(fetchImpl).toHaveBeenCalledWith("http://h/api/ci-runs/ci_1/checks", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ checks }),
    }));
  });

  it("posts bulk replacement for review threads under the PR-scoped URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    const threads = [{ id: "t1", prId: "o/r#1", path: "f.ts", line: 1, isResolved: false, commentsJson: "[]", createdAt: 1, updatedAt: 1 }];
    await client.replaceReviewThreads("o/r#1", threads);
    expect(fetchImpl).toHaveBeenCalledWith("http://h/api/pull-requests/o%2Fr%231/review-threads", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ threads }),
    }));
  });

  it("swallows a network throw (best-effort, never throws)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createDashboardClient({ baseUrl: "http://h", token: "t", logger, fetchImpl });
    await expect(client.recordEvent({ ticketId: null, runId: null, workerId: null, source: "manager", type: "progress", summary: "x", payloadJson: null, createdAt: 1 })).resolves.toBeUndefined();
  });
});
