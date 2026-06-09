import { describe, it, expect } from "vitest";
import { countWords, estimateComplexity, estimateCompletion } from "./complexity.js";
import { DEFAULT_HOURS_PER_COMPLEXITY } from "./config.js";

describe("countWords", () => {
  it("returns 0 for null/empty/whitespace", () => {
    expect(countWords(null)).toBe(0);
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t  ")).toBe(0);
  });

  it("splits on any whitespace", () => {
    expect(countWords("one")).toBe(1);
    expect(countWords("one two   three\nfour")).toBe(4);
  });
});

describe("estimateComplexity", () => {
  it("maps word-count buckets to base complexity", () => {
    expect(estimateComplexity(0, 1)).toBe(1);
    expect(estimateComplexity(49, 1)).toBe(1);
    expect(estimateComplexity(50, 1)).toBe(2);
    expect(estimateComplexity(149, 1)).toBe(2);
    expect(estimateComplexity(150, 1)).toBe(3);
    expect(estimateComplexity(399, 1)).toBe(3);
    expect(estimateComplexity(400, 1)).toBe(4);
    expect(estimateComplexity(799, 1)).toBe(4);
    expect(estimateComplexity(800, 1)).toBe(5);
    expect(estimateComplexity(10_000, 1)).toBe(5);
  });

  it("adds one point per retry beyond the first", () => {
    expect(estimateComplexity(0, 1)).toBe(1);
    expect(estimateComplexity(0, 2)).toBe(2);
    expect(estimateComplexity(0, 3)).toBe(3);
  });

  it("caps complexity at 5", () => {
    expect(estimateComplexity(300, 10)).toBe(5);
  });

  it("treats attemptCount 0 the same as 1 (no negative bump)", () => {
    expect(estimateComplexity(60, 0)).toBe(2);
  });
});

describe("estimateCompletion", () => {
  it("computes complexity and hours using the supplied table", () => {
    const result = estimateCompletion("word ".repeat(200), 1, DEFAULT_HOURS_PER_COMPLEXITY);
    expect(result).toEqual({ complexityScore: 3, estimatedHumanHours: 3.0 });
  });

  it("uses overridden hours table when provided", () => {
    const table = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 } as const;
    const result = estimateCompletion("x", 1, table);
    expect(result).toEqual({ complexityScore: 1, estimatedHumanHours: 1 });
  });
});
