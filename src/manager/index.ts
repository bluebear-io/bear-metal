import "dotenv/config";

import { createLogger, GitHubIntegration, LinearIntegration } from "../shared/index.js";
import { createWorkerProcess } from "../worker/index.js";

import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { TicketStore } from "./state.js";
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
const store = new TicketStore(logger);
const workerProcess = createWorkerProcess({ github, linear, logger });
const handler = new ManagerTicketHandler({ logger, worker: workerProcess });

const scheduler = new Scheduler({
  logger,
  linear,
  github,
  store,
  handler,
  agentId: config.linearAssigneeId,
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
});

const app = createServer({ store });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "health server listening");
  logger.info({ port: config.port, pid: process.pid }, "🐻 Bear Metal is awake and hungry for tickets — let's ship some code!");
});

scheduler.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  logger.info({ signal, pid: process.pid }, "🐻 Bear Metal is heading back to hibernation — see you on the next sprint!");
  void scheduler.stop().then(() => {
    server.close(() => {
      logger.info({ signal }, "health server closed, goodnight 🌙");
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
