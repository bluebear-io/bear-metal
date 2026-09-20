import "dotenv/config";

import { SqlDbClient } from "../db/client.js";
import { loadBearMetalConfig, resolveSecret } from "../customization/load.js";
import { DEFAULT_DATABASE_URL, DEFAULT_MAX_ITERATIONS } from "../customization/types.js";
import {
  AppTokenProvider,
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

const [runtimeConfig, customizationConfig] = await Promise.all([loadConfig(), loadBearMetalConfig()]);
const logger = createLogger({ level: runtimeConfig.logLevel, name: "manager", pretty: runtimeConfig.logPretty });
const maxIterations = customizationConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS;

logger.info(
  {
    githubAppId: customizationConfig.github.appId,
    githubInstallationId: customizationConfig.github.installationId,
    concurrency: runtimeConfig.workerConcurrency,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    apiOnly: runtimeConfig.apiOnly,
  },
  "config loaded",
);

const linear = new LinearIntegration({
  tokenProvider: new AppTokenProvider({
    clientId: customizationConfig.linear.clientId,
    clientSecret: await resolveSecret(customizationConfig.linear.getClientSecret, "config.linear.getClientSecret result"),
    scopes: customizationConfig.linear.oauthScopes ?? "read,write,app:assignable,app:mentionable",
    logger: createLogger({ level: runtimeConfig.logLevel, name: "linear-token", pretty: runtimeConfig.logPretty }),
  }),
});
const github = new GitHubIntegration({
  appId: customizationConfig.github.appId,
  privateKey: await resolveSecret(customizationConfig.github.getPrivateKey, "config.github.getPrivateKey result"),
  installationId: customizationConfig.github.installationId,
});
const slack =
  customizationConfig.slack
    ? new SlackIntegration({
      token: await resolveSecret(customizationConfig.slack.getBotToken, "config.slack.getBotToken result"),
      channel: customizationConfig.slack.notificationChannel,
      logger: createLogger({ level: runtimeConfig.logLevel, name: "slack", pretty: runtimeConfig.logPretty }),
    })
    : undefined;
if (!slack) {
  logger.warn(
    "Slack is not configured; PR open/update notifications disabled",
  );
}

const databaseUrl = customizationConfig.database
  ? await resolveSecret(customizationConfig.database.getUrl, "config.database.getUrl result")
  : DEFAULT_DATABASE_URL;
const db = new SqlDbClient(databaseUrl, maxIterations);
await db.initSchema();

const server = createApp(db, maxIterations, linear).listen(runtimeConfig.backendPort, () => {
  logger.info({ port: runtimeConfig.backendPort }, "dashboard server listening");
});

let scheduler: Scheduler | null = null;
let taskWorker: TaskWorker | null = null;

if (runtimeConfig.apiOnly) {
  logger.info("API-only mode: scheduler and worker disabled");
} else {
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
    concurrency: runtimeConfig.workerConcurrency,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    taskStaleAfterMs: runtimeConfig.taskStaleAfterMs,
    taskMaxReclaims: runtimeConfig.taskMaxReclaims,
    maxIterations,
    slack,
  });
  taskWorker = new TaskWorker({
    logger,
    db,
    integrations: { github, linear, slack, commentStore: db },
    concurrency: runtimeConfig.workerConcurrency,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    heartbeatIntervalMs: runtimeConfig.taskHeartbeatIntervalMs,
    maxReclaims: runtimeConfig.taskMaxReclaims,
    agentId,
    config: customizationConfig,
  });

  if (runtimeConfig.testTicketId) {
    logger.info({ ticketId: runtimeConfig.testTicketId }, "test mode: running single-ticket pipeline");
    let exitCode = 0;
    try {
      const ticket = await linear.getTicket(runtimeConfig.testTicketId);
      const ctx: TicketContext = { ticket, prs: [] };
      await handler.handle(ctx, "new");
      await taskWorker.tick();
      await taskWorker.stop();
      logger.info({ ticketId: runtimeConfig.testTicketId }, "test mode: pipeline complete");
    } catch (err) {
      logger.error({ err, ticketId: runtimeConfig.testTicketId }, "test mode: pipeline failed");
      exitCode = 1;
    } finally {
      // Always close the db so the DB connection is released and the SQLite WAL is checkpointed,
      // even when the pipeline throws partway through.
      await db.close();
    }
    process.exit(exitCode);
  }

  logger.info({ port: runtimeConfig.backendPort, pid: process.pid }, "🐻 Bear Metal is awake and hungry for tickets — let's ship some code!");

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
