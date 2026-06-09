import "dotenv/config";

import { createLogger, GitHubIntegration, LinearIntegration } from "../shared/index.js";
import { process as workerProcess } from "../worker/index.js";

import { loadConfig } from "./config.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { TicketStore } from "./state.js";
import { ManagerTicketHandler } from "./ticket-handler.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, name: "manager" });

logger.info(
  {
    label: config.linearLabel,
    repo: `${config.githubOwner}/${config.githubRepo}`,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.pollIntervalMs,
  },
  "config loaded",
);

const linear = new LinearIntegration({ token: config.linearApiToken });
const github = new GitHubIntegration({
  token: config.githubToken,
  owner: config.githubOwner,
  repo: config.githubRepo,
});
const store = new TicketStore();
const handler = new ManagerTicketHandler({ logger, worker: workerProcess });

const scheduler = new Scheduler({
  logger,
  linear,
  github,
  store,
  handler,
  label: config.linearLabel,
  concurrency: config.workerConcurrency,
  pollIntervalMs: config.pollIntervalMs,
});

const app = createServer({ store });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "health server listening");
});

scheduler.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  void scheduler.stop().then(() => {
    server.close(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
