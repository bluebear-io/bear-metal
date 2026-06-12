import "dotenv/config";

import {
  createLogger,
  GitHubIntegration,
  LinearIntegration,
  SlackIntegration,
  type TicketContext,
} from "../shared/index.js";
import { SqlDbClient } from "../db/client.js";
import { TaskWorker } from "../worker/index.js";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { ManagerTicketHandler } from "./ticket-handler.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: "manager", pretty: config.logPretty });

logger.info(
  {
    assigneeId: config.linearAssigneeId,
    githubAppId: config.githubAppId,
    githubInstallationId: config.githubAppInstallationId,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
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
const db = new SqlDbClient(config.databaseUrl);
await db.initSchema();

const handler = new ManagerTicketHandler({ logger, db });

const scheduler = new Scheduler({
  logger,
  linear,
  github,
  db,
  handler,
  agentId: config.linearAssigneeId,
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
  taskStaleAfterMs: config.taskStaleAfterMs,
  taskMaxReclaims: config.taskMaxReclaims,
});
const taskWorker = new TaskWorker({
  logger,
  db,
  integrations: { github, linear, slack, commentStore: db },
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
  heartbeatIntervalMs: config.taskHeartbeatIntervalMs,
  maxReclaims: config.taskMaxReclaims,
});

if (config.testTicketId) {
  // Test mode: handle exactly one ticket end-to-end and exit.
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

const app = createApp(db);
const server = app.listen(config.backendPort, () => {
  logger.info({ port: config.backendPort }, "dashboard server listening");
  logger.info({ port: config.backendPort, pid: process.pid }, "🐻 Bear Metal is awake and hungry for tickets — let's ship some code!");
});

scheduler.start();
taskWorker.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  logger.info({ signal, pid: process.pid }, "🐻 Bear Metal is heading back to hibernation — see you on the next sprint!");
  void Promise.all([scheduler.stop(), taskWorker.stop()])
    .then(() => db.close())
    .then(() => {
      server.close(() => {
        logger.info({ signal }, "dashboard server closed, goodnight 🌙");
        process.exit(0);
      });
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
