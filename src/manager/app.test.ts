import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DbClient, TicketListItem } from "../db/client.js";
import { createApp } from "./app.js";
import type { LinearSource } from "./scheduler.js";

function makeTicketListItem(): TicketListItem {
  const now = new Date("2026-07-13T08:00:00.000Z");
  return {
    id: "task-1",
    ticketId: "linear-ticket-1",
    ticketIdentifier: "DEN-2954",
    ticketTitle: "Fix Bear Metal UI",
    ticketDescription: null,
    ticketUrl: "https://linear.app/bluebearsecurity/issue/DEN-2954/fix-bear-metal-ui",
    ticketBranchName: "fix/DEN-2954/linear-auth-error-mapping",
    ticketLinearStatusName: "In Progress",
    ticketLinearStatusType: "started",
    ticketLabelsJson: "[]",
    bmStatus: "in_progress",
    attemptCount: 1,
    ticketCompletedAt: null,
    createdAt: now,
    updatedAt: now,
    latestRun: null,
    latestWorkerName: null,
    pullRequests: [],
  };
}

function makeLinearUnauthorizedError(): Error & { status: number } {
  const err = new Error("Authentication required, not authenticated - You need to authenticate to access this operation.");
  err.name = "AuthenticationLinearError";
  return Object.assign(err, { status: 401 });
}

describe("manager app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs catch-path failures and returns a generic 500 response", async () => {
    const err = makeLinearUnauthorizedError();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      listTickets: vi.fn().mockResolvedValue({
        items: [makeTicketListItem()],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    } as unknown as DbClient;
    const linear = {
      getTicketAssignees: vi.fn().mockRejectedValue(err),
    } as unknown as LinearSource;

    const res = await request(createApp(db, 3, linear)).get("/api/tickets?page=1&pageSize=20");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "oops, something went wrong" });
    expect(logSpy).toHaveBeenCalledWith("manager api request failed", err);
  });
});
