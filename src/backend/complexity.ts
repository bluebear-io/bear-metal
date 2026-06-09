import type { ComplexityLevel, HoursPerComplexity } from "./config.js";

/** Word count of a ticket description, treating null/empty as 0. */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Map (description word count, attempt count) → integer complexity 1–5.
 *
 * Word count picks the base bucket; each retry beyond the first adds 1, capped at 5.
 * Kept here rather than at the call site so the formula has a single source of truth
 * and is unit-testable in isolation.
 */
export function estimateComplexity(descriptionWordCount: number, attemptCount: number): ComplexityLevel {
  const base: ComplexityLevel =
    descriptionWordCount < 50 ? 1 :
    descriptionWordCount < 150 ? 2 :
    descriptionWordCount < 400 ? 3 :
    descriptionWordCount < 800 ? 4 : 5;
  const bumped = base + Math.max(0, attemptCount - 1);
  return Math.min(5, bumped) as ComplexityLevel;
}

export interface CompletionEstimate {
  complexityScore: ComplexityLevel;
  estimatedHumanHours: number;
}

/**
 * Compute the persisted (complexityScore, estimatedHumanHours) pair for a ticket that
 * has just reached bmStatus = "completed".
 */
export function estimateCompletion(
  description: string | null | undefined,
  attemptCount: number,
  hoursPerComplexity: HoursPerComplexity,
): CompletionEstimate {
  const complexityScore = estimateComplexity(countWords(description), attemptCount);
  return { complexityScore, estimatedHumanHours: hoursPerComplexity[complexityScore] };
}
