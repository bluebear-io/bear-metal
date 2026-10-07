export interface Config {
  workerConcurrency: number;
  pollIntervalMs: number;
  backendPort: number;
  logLevel: string;
  logPretty: boolean;
  testTicketId: string | null;
  apiOnly: boolean;
  runMode: "normal" | "slack_only";
  /** Worker heartbeat interval. Falls below the stale threshold by at least 5x. */
  taskHeartbeatIntervalMs: number;
  /** A task whose worker hasn't heartbeat within this many ms is considered crashed/hung. */
  taskStaleAfterMs: number;
  /** After this many recoveries of the same row, the manager abandons it (terminal + slot release). */
  taskMaxReclaims: number;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1";
}

export function positiveIntEnv(name: string, fallback: number): number {
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

export function loadConfig(): Readonly<Config> {
  const runMode = process.env.BEAR_METAL_RUN_MODE?.trim() || "normal";
  if (runMode !== "normal" && runMode !== "slack_only") {
    throw new Error(`BEAR_METAL_RUN_MODE must be normal or slack_only, got: ${runMode}`);
  }
  if (runMode === "slack_only" && process.env.TEST_TICKET_ID?.trim()) {
    throw new Error("TEST_TICKET_ID cannot be used with BEAR_METAL_RUN_MODE=slack_only");
  }
  return Object.freeze({
    workerConcurrency: positiveIntEnv("WORKER_CONCURRENCY", 5),
    pollIntervalMs: positiveIntEnv("POLL_INTERVAL_MS", 60_000),
    backendPort: positiveIntEnv("BACKEND_PORT", 3100),
    logLevel: process.env.LOG_LEVEL || "info",
    logPretty: boolEnv("LOG_PRETTY", false),
    testTicketId: process.env.TEST_TICKET_ID?.trim() || null,
    apiOnly: boolEnv("API_ONLY", false),
    runMode,
    taskHeartbeatIntervalMs: positiveIntEnv("TASK_HEARTBEAT_INTERVAL_MS", 30_000),
    taskStaleAfterMs: positiveIntEnv("TASK_STALE_AFTER_MS", 5 * 60_000),
    taskMaxReclaims: positiveIntEnv("TASK_MAX_RECLAIMS", 3),
  });
}
