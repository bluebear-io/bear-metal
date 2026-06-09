export type ComplexityLevel = 1 | 2 | 3 | 4 | 5;
export type HoursPerComplexity = Record<ComplexityLevel, number>;

export interface BackendConfig {
  dbPath: string;
  port: number;
  logLevel: string;
  /** Shared secret required on write routes; empty disables the write API. */
  ingestToken: string;
  /** Estimated human hours per complexity level, used to compute time-saved estimates. */
  hoursPerComplexity: HoursPerComplexity;
}

/** Default estimated human hours per complexity level. */
export const DEFAULT_HOURS_PER_COMPLEXITY: HoursPerComplexity = {
  1: 0.5,
  2: 1.5,
  3: 3.0,
  4: 6.0,
  5: 12.0,
};

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

const COMPLEXITY_KEYS: ReadonlyArray<keyof HoursPerComplexity> = [1, 2, 3, 4, 5];

function parseHoursPerComplexity(raw: string | undefined): HoursPerComplexity {
  if (raw === undefined || raw === "") {
    return { ...DEFAULT_HOURS_PER_COMPLEXITY };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`HOURS_PER_COMPLEXITY_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("HOURS_PER_COMPLEXITY_JSON must be a JSON object with keys \"1\"–\"5\"");
  }
  const obj = parsed as Record<string, unknown>;
  const result = {} as HoursPerComplexity;
  for (const k of COMPLEXITY_KEYS) {
    const v = obj[String(k)];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`HOURS_PER_COMPLEXITY_JSON["${k}"] must be a positive finite number, got: ${JSON.stringify(v)}`);
    }
    result[k] = v;
  }
  return result;
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
    hoursPerComplexity: parseHoursPerComplexity(env.HOURS_PER_COMPLEXITY_JSON),
  };
}
