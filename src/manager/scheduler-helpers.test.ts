import { describe, expect, it } from "vitest";

import { freeSlots, selectAdmissions } from "./scheduler.js";
import { makeTicket } from "./test-helpers.js";

describe("freeSlots", () => {
  it("returns remaining capacity", () => {
    expect(freeSlots(2, 0)).toBe(2);
    expect(freeSlots(2, 1)).toBe(1);
  });

  it("never goes negative", () => {
    expect(freeSlots(2, 5)).toBe(0);
  });
});

describe("selectAdmissions", () => {
  const candidates = [makeTicket("a"), makeTicket("b"), makeTicket("c")];
  const noneActive = () => false;

  it("admits up to the free-slot count", () => {
    expect(selectAdmissions(candidates, noneActive, 2).map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("skips already-active tickets", () => {
    const isActive = (id: string) => id === "a";
    expect(selectAdmissions(candidates, isActive, 2).map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("admits nothing when there are no free slots", () => {
    expect(selectAdmissions(candidates, noneActive, 0)).toEqual([]);
    expect(selectAdmissions(candidates, noneActive, -1)).toEqual([]);
  });
});
