export interface Config {
  linearApiToken: string;
  linearAssigneeId: string;
  githubAppId: number;
  githubAppPrivateKey: string;
  githubAppInstallationId: number;
  databaseUrl: string;
  workerConcurrency: number;
  pollIntervalMs: number;
  port: number;
  logLevel: string;
  logPretty: boolean;
  /** Base URL of the observability dashboard write API. Empty disables dashboard reporting. */
  dashboardUrl: string;
  /** Shared secret sent as a bearer token to the dashboard write API. */
  ingestToken: string;
  testTicketId: string | null;
  /** Optional Slack bot token (xoxb-...). When set together with slackNotificationChannel, PR open/update notifications are sent. */
  slackBotToken: string | null;
  /** Optional Slack channel id or name receiving PR notifications. */
  slackNotificationChannel: string | null;
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
    linearAssigneeId: requiredEnv("LINEAR_ASSIGNEE_ID"),
    githubAppId: requiredPositiveIntEnv("GITHUB_APP_ID"),
    // Stored in env with literal "\n" sequences; restore real newlines for the PEM.
    githubAppPrivateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    githubAppInstallationId: requiredPositiveIntEnv("GITHUB_APP_INSTALLATION_ID"),
    databaseUrl: process.env.DATABASE_URL || "sqlite:./bear-metal-manager.sqlite",
    workerConcurrency: positiveIntEnv("WORKER_CONCURRENCY", 5),
    pollIntervalMs: positiveIntEnv("POLL_INTERVAL_MS", 60_000),
    port: positiveIntEnv("PORT", 3000),
    logLevel: process.env.LOG_LEVEL || "info",
    logPretty: boolEnv("LOG_PRETTY", false),
    dashboardUrl: process.env.DASHBOARD_URL ?? "",
    ingestToken: process.env.INGEST_TOKEN ?? "",
    testTicketId: process.env.TEST_TICKET_ID?.trim() || null,
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
