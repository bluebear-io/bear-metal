export interface Config {
  linearApiToken: string;
  linearLabel: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  workerConcurrency: number;
  pollIntervalMs: number;
  port: number;
  logLevel: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

/** Load and validate configuration from the environment. Fails fast on bad input. */
export function loadConfig(): Readonly<Config> {
  return Object.freeze({
    linearApiToken: requiredEnv("LINEAR_API_TOKEN"),
    linearLabel: process.env.LINEAR_LABEL || "bear-metal",
    githubToken: requiredEnv("GITHUB_TOKEN"),
    githubOwner: requiredEnv("GITHUB_OWNER"),
    githubRepo: requiredEnv("GITHUB_REPO"),
    workerConcurrency: positiveIntEnv("WORKER_CONCURRENCY", 2),
    pollIntervalMs: positiveIntEnv("POLL_INTERVAL_MS", 60_000),
    port: positiveIntEnv("PORT", 3000),
    logLevel: process.env.LOG_LEVEL || "info",
  });
}
