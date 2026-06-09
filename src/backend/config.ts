export interface BackendConfig {
  dbPath: string;
  port: number;
  logLevel: string;
  /** Shared secret required on write routes; empty disables the write API. */
  ingestToken: string;
  /** Monthly USD budget for cost burndown; null when MONTHLY_BUDGET_USD is unset. */
  monthlyBudgetUsd: number | null;
}

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

// Default prices in USD per 1M tokens as of mid-2026.
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8":    { inputPer1M: 15.00, outputPer1M: 75.00 },
  "claude-sonnet-4-6":  { inputPer1M:  3.00, outputPer1M: 15.00 },
  "claude-haiku-4-5":   { inputPer1M:  0.80, outputPer1M:  4.00 },
};

let activeModelPrices: Record<string, ModelPrice> = parseModelPricesFromEnv(process.env.MODEL_PRICES_JSON) ?? DEFAULT_MODEL_PRICES;

function parseModelPricesFromEnv(raw: string | undefined): Record<string, ModelPrice> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`MODEL_PRICES_JSON is not valid JSON (${reason})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MODEL_PRICES_JSON must be a JSON object keyed by model id");
  }
  const out: Record<string, ModelPrice> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) throw new Error(`MODEL_PRICES_JSON.${k} must be an object`);
    const entry = v as Record<string, unknown>;
    const inputPer1M = entry.inputPer1M;
    const outputPer1M = entry.outputPer1M;
    if (typeof inputPer1M !== "number" || typeof outputPer1M !== "number") {
      throw new Error(`MODEL_PRICES_JSON.${k} must have numeric inputPer1M and outputPer1M`);
    }
    out[k] = { inputPer1M, outputPer1M };
  }
  return out;
}

/** Looks up a model's per-1M-token USD price. Unknown models fall back to opus pricing (conservative). */
export function modelPrice(modelId: string): ModelPrice {
  return activeModelPrices[modelId] ?? { inputPer1M: 15.00, outputPer1M: 75.00 };
}

/** Test/CLI hook to swap the active price table. */
export function setModelPrices(prices: Record<string, ModelPrice>): void {
  activeModelPrices = prices;
}

function positiveIntEnv(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

/**
 * Backend env config. The DB path is mandatory — a missing value is a configuration
 * error and must fail fast rather than fall back to a guessed location.
 */
export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const dbPath = env.BEAR_METAL_DB_PATH;
  if (!dbPath) {
    throw new Error("BEAR_METAL_DB_PATH is required but was not set");
  }
  return {
    dbPath,
    port: positiveIntEnv(env.BACKEND_PORT, "BACKEND_PORT", 3100),
    logLevel: env.LOG_LEVEL ?? "info",
    ingestToken: env.INGEST_TOKEN ?? "",
    monthlyBudgetUsd: parseMonthlyBudget(env.MONTHLY_BUDGET_USD),
  };
}

function parseMonthlyBudget(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`MONTHLY_BUDGET_USD must be a non-negative number, got: ${raw}`);
  }
  return parsed;
}
