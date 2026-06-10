export type DatabaseDialect = "sqlite" | "postgres";

export interface BackendConfig {
  databaseUrl: string;
  dialect: DatabaseDialect;
  port: number;
  logLevel: string;
  /** Shared secret required on write routes; empty disables the write API. */
  ingestToken: string;
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

/** Parse the URL scheme and return the dialect, or throw on an unsupported one. */
export function detectDialect(databaseUrl: string): DatabaseDialect {
  if (databaseUrl.startsWith("sqlite:")) return "sqlite";
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) return "postgres";
  throw new Error(`Unsupported BEAR_METAL_DATABASE_URL scheme: ${databaseUrl}`);
}

/**
 * Backend env config. The DB URL is mandatory — a missing value is a configuration
 * error and must fail fast rather than fall back to a guessed location.
 */
export function loadBackendConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const databaseUrl = env.BEAR_METAL_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("BEAR_METAL_DATABASE_URL is required but was not set");
  }
  const dialect = detectDialect(databaseUrl);
  return {
    databaseUrl,
    dialect,
    port: positiveIntEnv(env.BACKEND_PORT, "BACKEND_PORT", 3100),
    logLevel: env.LOG_LEVEL ?? "info",
    ingestToken: env.INGEST_TOKEN ?? "",
  };
}
