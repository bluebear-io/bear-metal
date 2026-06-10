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
    const isActive = (identifier: string) => identifier === "A";
    expect(selectAdmissions(candidates, isActive, 2).map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("admits nothing when there are no free slots", () => {
    expect(selectAdmissions(candidates, noneActive, 0)).toEqual([]);
    expect(selectAdmissions(candidates, noneActive, -1)).toEqual([]);
  });

  it("sorts candidates by Linear priority (Urgent before High before Medium before Low before No Priority)", () => {
    const mixed = [
      makeTicket("low", { priority: 4 }),
      makeTicket("none", { priority: 0 }),
      makeTicket("urgent", { priority: 1 }),
      makeTicket("medium", { priority: 3 }),
      makeTicket("high", { priority: 2 }),
    ];
    expect(selectAdmissions(mixed, noneActive, 5).map((t) => t.id)).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
      "none",
    ]);
  });

  it("admits the highest-priority candidates first when free slots are limited", () => {
    const mixed = [
      makeTicket("low", { priority: 4 }),
      makeTicket("none", { priority: 0 }),
      makeTicket("urgent", { priority: 1 }),
      makeTicket("high", { priority: 2 }),
    ];
    expect(selectAdmissions(mixed, noneActive, 2).map((t) => t.id)).toEqual(["urgent", "high"]);
  });

  it("is stable within a priority bucket, preserving Linear's returned order", () => {
    const sameBucket = [
      makeTicket("first", { priority: 2 }),
      makeTicket("second", { priority: 2 }),
      makeTicket("third", { priority: 2 }),
    ];
    expect(selectAdmissions(sameBucket, noneActive, 3).map((t) => t.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
