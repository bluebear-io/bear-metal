import "dotenv/config";

import { createLogger, GitHubIntegration, LinearIntegration } from "../shared/index.js";
import { TaskWorker } from "../worker/index.js";

import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { TicketStore } from "./state.js";
import { createTaskQueueFromDatabaseUrl } from "./tasks.js";
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
const tasks = createTaskQueueFromDatabaseUrl(config.databaseUrl);
await tasks.initialize();
const store = new TicketStore(logger);
const handler = new ManagerTicketHandler({ logger, tasks });

const scheduler = new Scheduler({
  logger,
  linear,
  github,
  store,
  tasks,
  handler,
  agentId: config.linearAssigneeId,
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
});
const taskWorker = new TaskWorker({
  logger,
  tasks,
  integrations: { github, linear },
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
});

const app = createServer({ store });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "health server listening");
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
  void Promise.all([scheduler.stop(), taskWorker.stop()])
    .then(() => tasks.close())
    .then(() => {
      server.close(() => process.exit(0));
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
