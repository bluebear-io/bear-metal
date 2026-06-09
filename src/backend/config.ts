export interface BackendConfig {
  dbPath: string;
  port: number;
  logLevel: string;
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
  };
}
