import { describe, expect, it } from "vitest";
import { freshTokens } from "./token-budget.js";

describe("fresh token budget", () => {
  it("excludes cache reads and counts uncached input, cache writes and output once", () => {
    expect(freshTokens({ input: 0, output: 0, cacheWrite: 0, cacheRead: 30_000_000 })).toBe(0);
    expect(freshTokens({ input: 100, output: 20, cacheWrite: 80, cacheRead: 30_000_000 })).toBe(200);
  });
  it.each([-1, NaN, Infinity])("rejects invalid usage %s", (input) => {
    expect(() => freshTokens({ input, output: 0, cacheWrite: 0, cacheRead: 0 })).toThrow();
  });
});
