import "dotenv/config";

import { SqlDbClient } from "../db/client.js";
import { AgentToolGateway } from "../agent-tools/gateway.js";
import { createAgentToolHandlers } from "../agent-tools/handlers.js";
import { loadBearMetalConfig, resolveSecret } from "../customization/load.js";
import { DEFAULT_CI_DEFERRAL_MAX_MS, DEFAULT_DATABASE_URL, DEFAULT_MAX_ITERATIONS } from "../customization/types.js";
import {
  AppTokenProvider,
  createLogger,
  GitHubIntegration,
  LinearIntegration,
  SlackIntegration,
  SlackReadClient,
  type TicketContext,
} from "../shared/index.js";
import { TaskWorker } from "../worker/index.js";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { ManagerTicketHandler } from "./ticket-handler.js";
import { createSlackEventsRouter } from "./slack-events.js";
import { SlackThreadApi } from "./slack-thread-api.js";
import { SlackCoordinator } from "./slack-coordinator.js";
import { SlackResearchWorker } from "./slack-research.js";

const runtimeConfig = loadConfig();
const logger = createLogger({ level: runtimeConfig.logLevel, name: "manager", pretty: runtimeConfig.logPretty });
let fatalExitStarted = false;

function fatalExit(err: unknown, origin: "uncaughtException" | "unhandledRejection"): void {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  logger.fatal({ err, origin }, "fatal process error");
  logger.flush(() => process.exit(1));
}

process.on("uncaughtException", (err) => fatalExit(err, "uncaughtException"));
process.on("unhandledRejection", (reason) => fatalExit(reason, "unhandledRejection"));

async function main(): Promise<void> {
const customizationConfig = await loadBearMetalConfig();
const maxIterations = customizationConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS;
const ciDeferralMaxMs = customizationConfig.ciDeferralMaxMs ?? DEFAULT_CI_DEFERRAL_MAX_MS;

logger.info(
  {
    githubAppId: customizationConfig.github.appId,
    githubInstallationId: customizationConfig.github.installationId,
    concurrency: runtimeConfig.workerConcurrency,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    apiOnly: runtimeConfig.apiOnly,
    runMode: runtimeConfig.runMode,
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
const agentConfig = customizationConfig.agentIntegrations;
const agentGithub = agentConfig?.github
  ? new GitHubIntegration({
    appId: agentConfig.github.appId,
    privateKey: await resolveSecret(agentConfig.github.getPrivateKey, "config.agentIntegrations.github.getPrivateKey result"),
    installationId: agentConfig.github.installationId,
  })
  : undefined;
const agentLinearTokenProvider = agentConfig?.linear
  ? new AppTokenProvider({
    clientId: agentConfig.linear.clientId,
    clientSecret: await resolveSecret(agentConfig.linear.getClientSecret, "config.agentIntegrations.linear.getClientSecret result"),
    scopes: agentConfig.linear.oauthScopes ?? "read",
    logger: createLogger({ level: runtimeConfig.logLevel, name: "agent-linear-token", pretty: runtimeConfig.logPretty }),
  })
  : undefined;
const agentSlack = agentConfig?.slack
  ? new SlackReadClient({
    token: await resolveSecret(agentConfig.slack.getBotToken, "config.agentIntegrations.slack.getBotToken result"),
  })
  : undefined;
const agentToolHandlers = createAgentToolHandlers({
  github: agentGithub,
  linear: agentLinearTokenProvider,
  slack: agentSlack,
  githubDispatchPolicy: agentConfig?.github?.dispatch,
  web: agentConfig?.web,
});
const agentToolGateway = Object.keys(agentToolHandlers).length > 0
  ? new AgentToolGateway({ handlers: agentToolHandlers, logger })
  : undefined;
const slackToken = customizationConfig.slack
  ? await resolveSecret(customizationConfig.slack.getBotToken, "config.slack.getBotToken result")
  : undefined;
const slack =
  customizationConfig.slack && slackToken
    ? new SlackIntegration({
      token: slackToken,
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
const traceRetentionDays = customizationConfig.traceRetentionDays ?? 14;
await db.purgeAgentTraces(traceRetentionDays);
const tracePurgeTimer = setInterval(() => {
  void db.purgeAgentTraces(traceRetentionDays).catch((err) => logger.error({ err }, "agent trace retention cleanup failed"));
}, 60 * 60 * 1000);

let scheduler: Scheduler | null = null;
let taskWorker: TaskWorker | null = null;
let slackCoordinator: SlackCoordinator | null = null;
let slackResearch: SlackResearchWorker | null = null;
let slackEvents: ReturnType<typeof createSlackEventsRouter> | undefined;

if (!runtimeConfig.apiOnly && slack && slackToken && customizationConfig.slack?.getSigningSecret) {
  const slackRead = new SlackReadClient({ token: slackToken });
  const auth = await slackRead.call("auth.test") as { ok?: boolean; user_id?: string; team_id?: string; error?: string };
  if (!auth.ok || !auth.user_id || !auth.team_id) throw new Error(`Slack auth.test failed: ${auth.error ?? "missing user_id or team_id"}`);
  const threadApi = new SlackThreadApi(slackRead, slack);
  const slackGatewayHandlers = createAgentToolHandlers({
    github: agentGithub,
    linear: agentLinearTokenProvider,
    slack: slackRead,
    web: agentConfig?.web,
  });
  const slackGateway = new AgentToolGateway({ handlers: slackGatewayHandlers, logger });
  slackCoordinator = new SlackCoordinator({
    db, api: threadApi, linear, github, config: customizationConfig, gateway: slackGateway, logger, botUserId: auth.user_id,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    wakeResearch: () => slackResearch?.wake(),
  });
  slackResearch = new SlackResearchWorker({
    db, github, config: customizationConfig, gateway: slackGateway, logger,
    pollIntervalMs: runtimeConfig.pollIntervalMs,
    wakeThread: (key) => slackCoordinator!.wake(key),
  });
  slackEvents = createSlackEventsRouter({
    db,
    signingSecret: await resolveSecret(customizationConfig.slack.getSigningSecret, "config.slack.getSigningSecret result"),
    botUserId: auth.user_id,
    workspaceId: auth.team_id,
    logger,
    wake: (key) => slackCoordinator!.wake(key),
  });
}
if (runtimeConfig.runMode === "slack_only" && (!slackCoordinator || !slackResearch || !slackEvents)) {
  throw new Error("slack_only mode requires Slack bot token and signing secret");
}

const server = createApp(db, maxIterations, linear, slackEvents).listen(runtimeConfig.backendPort, () => {
  logger.info({ port: runtimeConfig.backendPort }, "dashboard server listening");
});

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
    ciDeferralMaxMs,
    shouldRetryCi: customizationConfig.shouldRetryCi,
    maxIterations,
    slack,
  });
  taskWorker = new TaskWorker({
    logger,
    db,
    integrations: { github, linear, slack, commentStore: db },
    agentToolGateway,
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

  if (runtimeConfig.runMode === "normal") {
    scheduler.start();
    taskWorker.start();
  } else {
    logger.info("Slack-only mode: Linear scheduler and coding worker disabled");
  }
  if (slackResearch) await slackResearch.start();
  slackCoordinator?.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(tracePurgeTimer);
  logger.info({ signal }, "shutting down");
  logger.info({ signal, pid: process.pid }, "🐻 Bear Metal is heading back to hibernation — see you on the next sprint!");
  void Promise.all([scheduler?.stop(), taskWorker?.stop(), slackCoordinator?.stop(), slackResearch?.stop()])
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
}

void main();
