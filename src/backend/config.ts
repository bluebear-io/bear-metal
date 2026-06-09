export interface BackendConfig {
  dbPath: string;
  port: number;
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
  return { dbPath, port: Number(env.BACKEND_PORT ?? 3100) };
}
