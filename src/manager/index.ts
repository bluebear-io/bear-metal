import "dotenv/config";

import { createLogger, GitHubIntegration, LinearIntegration, type TicketContext } from "../shared/index.js";
import { TaskWorker } from "../worker/index.js";

import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
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
const handler = new ManagerTicketHandler({ logger, tasks });

const scheduler = new Scheduler({
  logger,
  linear,
  github,
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

if (config.testTicketId) {
  // Test mode: handle exactly one ticket end-to-end and exit.
  logger.info({ ticketId: config.testTicketId }, "test mode: running single-ticket pipeline");
  let exitCode = 0;
  try {
    const ticket = await linear.getTicket(config.testTicketId);
    const ctx: TicketContext = { ticket, prs: [] };
    await handler.handle(ctx);
    await taskWorker.tick();
    await taskWorker.stop();
    logger.info({ ticketId: config.testTicketId }, "test mode: pipeline complete");
  } catch (err) {
    logger.error({ err, ticketId: config.testTicketId }, "test mode: pipeline failed");
    exitCode = 1;
  } finally {
    // Always close the task queue so the DB connection is released and the SQLite WAL is checkpointed,
    // even when the pipeline throws partway through.
    await tasks.close();
  }
  process.exit(exitCode);
}

const app = createServer({ tasks });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "health server listening");
  logger.info({ port: config.port, pid: process.pid }, "🐻 Bear Metal is awake and hungry for tickets — let's ship some code!");
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
    .then(() => tasks.close())
    .then(() => {
      server.close(() => {
        logger.info({ signal }, "health server closed, goodnight 🌙");
        process.exit(0);
      });
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
