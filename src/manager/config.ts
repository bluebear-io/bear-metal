export type DatabaseDialect = "sqlite" | "postgres";

export function detectDialect(databaseUrl: string): DatabaseDialect {
  if (databaseUrl.startsWith("sqlite:")) return "sqlite";
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) return "postgres";
  throw new Error(`Unsupported DATABASE_URL scheme: ${databaseUrl}`);
}

export interface Config {
  linearApiToken: string;
  githubAppId: number;
  githubAppPrivateKey: string;
  githubAppInstallationId: number;
  databaseUrl: string;
  workerConcurrency: number;
  pollIntervalMs: number;
  backendPort: number;
  logLevel: string;
  logPretty: boolean;
  testTicketId: string | null;
  /** Optional Slack bot token (xoxb-...). When set together with slackNotificationChannel, PR open/update notifications are sent. */
  slackBotToken: string | null;
  /** Optional Slack channel id or name receiving PR notifications. */
  slackNotificationChannel: string | null;
  /** Worker heartbeat interval. Falls below the stale threshold by at least 5x. */
  taskHeartbeatIntervalMs: number;
  /** A task whose worker hasn't heartbeat within this many ms is considered crashed/hung. */
  taskStaleAfterMs: number;
  /** After this many recoveries of the same row, the manager abandons it (terminal + slot release). */
  taskMaxReclaims: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredPositiveIntEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw === "true" || raw === "1";
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
    githubAppId: requiredPositiveIntEnv("GITHUB_APP_ID"),
    // Stored in env with literal "\n" sequences; restore real newlines for the PEM.
    githubAppPrivateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    githubAppInstallationId: requiredPositiveIntEnv("GITHUB_APP_INSTALLATION_ID"),
    databaseUrl: process.env.DATABASE_URL || "sqlite:./data/bear-metal.sqlite",
    workerConcurrency: positiveIntEnv("WORKER_CONCURRENCY", 5),
    pollIntervalMs: positiveIntEnv("POLL_INTERVAL_MS", 60_000),
    backendPort: positiveIntEnv("BACKEND_PORT", 3100),
    logLevel: process.env.LOG_LEVEL || "info",
    logPretty: boolEnv("LOG_PRETTY", false),
    testTicketId: process.env.TEST_TICKET_ID?.trim() || null,
    taskHeartbeatIntervalMs: positiveIntEnv("TASK_HEARTBEAT_INTERVAL_MS", 30_000),
    taskStaleAfterMs: positiveIntEnv("TASK_STALE_AFTER_MS", 5 * 60_000),
    taskMaxReclaims: positiveIntEnv("TASK_MAX_RECLAIMS", 3),
    ...loadSlackConfig(),
  });
}

/**
 * Slack is opt-in: both vars must be set to enable notifications, or both must be
 * empty to disable them. Setting only one is a misconfiguration we surface loudly.
 */
function loadSlackConfig(): { slackBotToken: string | null; slackNotificationChannel: string | null } {
  const token = process.env.SLACK_BOT_TOKEN?.trim() || null;
  const channel = process.env.SLACK_NOTIFICATION_CHANNEL?.trim() || null;
  if ((token && !channel) || (!token && channel)) {
    throw new Error(
      "SLACK_BOT_TOKEN and SLACK_NOTIFICATION_CHANNEL must be set together (or both unset to disable Slack notifications)",
    );
  }
  return { slackBotToken: token, slackNotificationChannel: channel };
}
