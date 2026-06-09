import { describe, expect, it } from "vitest";

import { TicketStore } from "./state.js";
import { makeContext } from "./test-helpers.js";

describe("TicketStore", () => {
  it("upserts a ticket as active", () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"));
    expect(store.activeCount()).toBe(1);
    expect(store.isActive("a")).toBe(true);
    expect(store.get("a")?.status).toBe("active");
  });

  it("preserves admittedAt across refreshes but updates updatedAt", () => {
    const store = new TicketStore();
    const first = store.upsert("a", makeContext("a"));
    const second = store.upsert("a", makeContext("a"));
    expect(second.admittedAt.getTime()).toBe(first.admittedAt.getTime());
    expect(store.activeCount()).toBe(1);
  });

  it("reports inactive for unknown tickets", () => {
    const store = new TicketStore();
    expect(store.isActive("missing")).toBe(false);
    expect(store.get("missing")).toBeUndefined();
  });

  it("removes a ticket and frees the slot", () => {
    const store = new TicketStore();
    store.upsert("a", makeContext("a"));
    store.upsert("b", makeContext("b"));
    expect(store.activeCount()).toBe(2);
    store.remove("a");
    expect(store.activeCount()).toBe(1);
    expect(store.isActive("a")).toBe(false);
  });
});
