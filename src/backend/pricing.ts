/**
 * Fixed LLM pricing table used for cost estimates on the dashboard.
 *
 * Prices are in USD per 1M tokens. We intentionally keep this list small and
 * hand-curated rather than pulling from a live model registry: cost estimates
 * on the dashboard are a display concern, not billing. Unknown models fall
 * through to `null` and the UI renders "—".
 *
 * Lookup is by `(provider, modelName)`. Model name matching is done with a
 * lowercased prefix so minor SKU suffixes (e.g. "-20250219") still hit the
 * right row.
 */

export interface ModelPrice {
  /** USD per 1M input/prompt tokens. */
  inputPer1M: number;
  /** USD per 1M output/completion tokens. */
  outputPer1M: number;
}

interface PriceEntry extends ModelPrice {
  provider: string;
  /** Lowercased prefix matched against the model name. */
  modelPrefix: string;
}

const PRICE_TABLE: PriceEntry[] = [
  // Anthropic — Claude
  { provider: "anthropic", modelPrefix: "claude-opus-4", inputPer1M: 15, outputPer1M: 75 },
  { provider: "anthropic", modelPrefix: "claude-sonnet-4", inputPer1M: 3, outputPer1M: 15 },
  { provider: "anthropic", modelPrefix: "claude-haiku", inputPer1M: 0.8, outputPer1M: 4 },
  { provider: "anthropic", modelPrefix: "claude-3-5-sonnet", inputPer1M: 3, outputPer1M: 15 },
  { provider: "anthropic", modelPrefix: "claude-3-5-haiku", inputPer1M: 0.8, outputPer1M: 4 },
  { provider: "anthropic", modelPrefix: "claude-3-opus", inputPer1M: 15, outputPer1M: 75 },
  { provider: "anthropic", modelPrefix: "claude", inputPer1M: 3, outputPer1M: 15 },
  // OpenAI — GPT
  { provider: "openai", modelPrefix: "gpt-5", inputPer1M: 1.25, outputPer1M: 10 },
  { provider: "openai", modelPrefix: "gpt-4.1", inputPer1M: 2, outputPer1M: 8 },
  { provider: "openai", modelPrefix: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.6 },
  { provider: "openai", modelPrefix: "gpt-4o", inputPer1M: 2.5, outputPer1M: 10 },
  { provider: "openai", modelPrefix: "o3", inputPer1M: 2, outputPer1M: 8 },
  { provider: "openai", modelPrefix: "o4", inputPer1M: 2, outputPer1M: 8 },
  { provider: "openai", modelPrefix: "gpt", inputPer1M: 2.5, outputPer1M: 10 },
  // Google — Gemini
  { provider: "google", modelPrefix: "gemini-2.5-pro", inputPer1M: 1.25, outputPer1M: 10 },
  { provider: "google", modelPrefix: "gemini-2.5-flash", inputPer1M: 0.3, outputPer1M: 2.5 },
  { provider: "google", modelPrefix: "gemini-2.0", inputPer1M: 0.1, outputPer1M: 0.4 },
  { provider: "google", modelPrefix: "gemini", inputPer1M: 1.25, outputPer1M: 10 },
];

function getModelPrice(provider: string | null, modelName: string | null): ModelPrice | null {
  if (!provider || !modelName) return null;
  const p = provider.toLowerCase();
  const m = modelName.toLowerCase();
  for (const entry of PRICE_TABLE) {
    if (entry.provider === p && m.startsWith(entry.modelPrefix)) {
      return { inputPer1M: entry.inputPer1M, outputPer1M: entry.outputPer1M };
    }
  }
  return null;
}

/** Returns the estimated USD cost for the given token counts, or null if pricing is unknown. */
export function estimateCostUsd(
  provider: string | null,
  modelName: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  const price = getModelPrice(provider, modelName);
  if (!price) return null;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return (prompt / 1_000_000) * price.inputPer1M + (completion / 1_000_000) * price.outputPer1M;
}

/** Bucket a model into one of the comparison families displayed in the UI. */
export function modelFamily(provider: string | null, modelName: string | null): "claude" | "gpt" | "gemini" | "other" {
  const p = (provider ?? "").toLowerCase();
  const m = (modelName ?? "").toLowerCase();
  if (p === "anthropic" || m.includes("claude")) return "claude";
  if (p === "openai" || m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("o4")) return "gpt";
  if (p === "google" || m.includes("gemini")) return "gemini";
  return "other";
}
