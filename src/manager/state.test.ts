import { describe, expect, it } from "vitest";

import type { PullRequest } from "../shared/index.js";
import { TicketStore } from "./state.js";
import { makeContext, makeTicket } from "./test-helpers.js";

const PR: PullRequest = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "PR",
  headRef: "feature/a",
  state: "open",
  draft: false,
  merged: false,
  url: "https://github.com/acme/widgets/pull/7",
};

describe("TicketStore", () => {
  it("admits a ticket as new + pending when it has no PR", () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"));
    expect(store.count()).toBe(1);
    expect(store.has("a")).toBe(true);
    const state = store.get("a");
    expect(state?.state).toBe("new");
    expect(state?.status).toBe("pending");
  });

  it("marks a ticket as iteration when it has a PR", () => {
    const store = new TicketStore();
    store.upsert("a", { ticket: makeTicket("a"), pr: PR });
    expect(store.get("a")?.state).toBe("iteration");
  });

  it("preserves admittedAt and status across refreshes", () => {
    const store = new TicketStore();
    const first = store.upsert("a", makeContext("a"));
    store.setStatus("a", "done");
    const second = store.upsert("a", makeContext("a"));
    expect(second.admittedAt.getTime()).toBe(first.admittedAt.getTime());
    expect(second.status).toBe("done");
  });

  it("setStatus updates the status and throws for unknown tickets", () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"));
    expect(store.setStatus("a", "done").status).toBe("done");
    expect(() => store.setStatus("missing", "done")).toThrow(/unknown ticket/);
  });

  it("count/has reflect membership; remove frees the slot", () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"));
    store.upsert("b", makeContext("b"));
    expect(store.count()).toBe(2);
    store.remove("a");
    expect(store.count()).toBe(1);
    expect(store.has("a")).toBe(false);
  });
});
