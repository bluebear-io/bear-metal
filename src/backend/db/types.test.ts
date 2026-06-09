import { describe, it, expectTypeOf } from "vitest";
import type { Ticket, Worker, Run, PullRequestRow, CiRun, EventRow } from "./types.js";

describe("row types", () => {
  it("Ticket has the expected key fields", () => {
    expectTypeOf<Ticket>().toHaveProperty("identifier");
    expectTypeOf<Ticket>().toHaveProperty("bmStatus");
    expectTypeOf<Worker>().toHaveProperty("status");
    expectTypeOf<Run>().toHaveProperty("attemptNumber");
    expectTypeOf<PullRequestRow>().toHaveProperty("headRef");
    expectTypeOf<CiRun>().toHaveProperty("status");
    expectTypeOf<EventRow>().toHaveProperty("type");
  });
});
