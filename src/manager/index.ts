import "dotenv/config";

import { SqlDbClient } from "../db/client.js";
import {
  createLogger,
  GitHubIntegration,
  LinearIntegration,
  SlackIntegration,
  type TicketContext,
} from "../shared/index.js";
import { TaskWorker } from "../worker/index.js";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { ManagerTicketHandler } from "./ticket-handler.js";
import { runWorkerEnvironmentBuilder } from "./worker-env-builder.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: "manager", pretty: config.logPretty });

logger.info(
  {
    githubAppId: config.githubAppId,
    githubInstallationId: config.githubAppInstallationId,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    apiOnly: config.apiOnly,
  },
  "config loaded",
);

const linear = new LinearIntegration({ token: config.linearApiToken });
const github = new GitHubIntegration({
  appId: config.githubAppId,
  privateKey: config.githubAppPrivateKey,
  installationId: config.githubAppInstallationId,
});
const slack =
  config.slackBotToken && config.slackNotificationChannel
    ? new SlackIntegration({
      token: config.slackBotToken,
      channel: config.slackNotificationChannel,
      logger: createLogger({ level: config.logLevel, name: "slack", pretty: config.logPretty }),
    })
    : undefined;
if (!slack) {
  logger.warn(
    "SLACK_BOT_TOKEN/SLACK_NOTIFICATION_CHANNEL not set; PR open/update Slack notifications disabled",
  );
}

const db = new SqlDbClient(config.databaseUrl, config.maxIterations);
await db.initSchema();

// Start the HTTP server (full API + UI) before runWorkerEnvironmentBuilder so
// the container healthcheck and dashboard are available while the builder runs
// (which can take up to 30 minutes). The worker/scheduler loops only start
// after the builder completes. Skipped only in single-ticket test mode.
const server = createApp(db, config.maxIterations, linear).listen(config.backendPort, () => {
  logger.info({ port: config.backendPort }, "dashboard server listening");
});

let scheduler: Scheduler | null = null;
let taskWorker: TaskWorker | null = null;

if (config.apiOnly) {
  logger.info("API-only mode: scheduler and worker disabled");
} else {
  await runWorkerEnvironmentBuilder({
    command: config.workerEnvironmentBuilderCommand,
    path: config.workerEnvironmentBuilderPath,
    logger,
  });

  const agentId = await linear.getAgentId().catch((err) => {
    logger.warn({ err }, "failed to resolve Linear agent id; task delegation checks disabled");
    return undefined;
  });

  const handler = new ManagerTicketHandler({ logger, db });

  scheduler = new Scheduler({
    logger,
    linear,
    github,
    db,
    handler,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    taskStaleAfterMs: config.taskStaleAfterMs,
    taskMaxReclaims: config.taskMaxReclaims,
    maxIterations: config.maxIterations,
    slack,
  });
  taskWorker = new TaskWorker({
    logger,
    db,
    integrations: { github, linear, slack, commentStore: db },
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.taskHeartbeatIntervalMs,
    maxReclaims: config.taskMaxReclaims,
    agentId,
    workspaceBuilderCommand: config.workspaceBuilderCommand ?? undefined,
    workspaceBuilderPath: config.workspaceBuilderPath ?? undefined,
    systemPrompt: config.systemPrompt,
    maxWorkerTimeMs: config.maxWorkerTimeMs,
    maxWorkerTokens: config.maxWorkerTokens,
    llmProvider: config.llmProvider,
    llmApiKey: config.llmApiKey,
  });

  if (config.testTicketId) {
    logger.info({ ticketId: config.testTicketId }, "test mode: running single-ticket pipeline");
    let exitCode = 0;
    try {
      const ticket = await linear.getTicket(config.testTicketId);
      const ctx: TicketContext = { ticket, prs: [] };
      await handler.handle(ctx, "new");
      await taskWorker.tick();
      await taskWorker.stop();
      logger.info({ ticketId: config.testTicketId }, "test mode: pipeline complete");
    } catch (err) {
      logger.error({ err, ticketId: config.testTicketId }, "test mode: pipeline failed");
      exitCode = 1;
    } finally {
      // Always close the db so the DB connection is released and the SQLite WAL is checkpointed,
      // even when the pipeline throws partway through.
      await db.close();
    }
    process.exit(exitCode);
  }

  logger.info({ port: config.backendPort, pid: process.pid }, "🐻 Bear Metal is awake and hungry for tickets — let's ship some code!");

  scheduler.start();
  taskWorker.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  logger.info({ signal, pid: process.pid }, "🐻 Bear Metal is heading back to hibernation — see you on the next sprint!");
  void Promise.all([scheduler?.stop(), taskWorker?.stop()])
    .then(() => db.close())
    .then(() => {
      if (!server) {
        process.exit(0);
        return;
      }
      server.close(() => {
        logger.info({ signal }, "dashboard server closed, goodnight 🌙");
        process.exit(0);
      });
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
