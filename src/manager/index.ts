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
const startedAt = new Date();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "health server listening");
  logger.info(
    {
      port: config.port,
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      startedAt: startedAt.toISOString(),
    },
    "server start: manager process is up and accepting traffic",
  );
  logger.info(
    { port: config.port, pid: process.pid },
    "🐻 Bear Metal is awake, caffeinated, and dangerously hungry for tickets — it rolled out of the cave at sunrise, stretched until its spine cracked like a stale changelog, growled at the standup bot, sniffed the entire backlog, licked a stray semicolon off its paw, and picked the juiciest Linear ticket off the top of the pile. It has now lumbered up to the keyboard, cracked its knuckles, opened seventeen tabs of MDN, muttered something rude about CommonJS, and started typing. Reviewers, brace yourselves: there will be PRs, there will be diffs, there will be force-pushes at 2am, there will be honey-flavored commit messages, and somewhere — somewhere — there will be a TODO that says 'fix later (sorry future bear)'. Sharpen your nits, polish your LGTMs, and hide the snacks. 🍯⌨️🐾📈",
  );
});

scheduler.start();

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const uptimeSeconds = process.uptime();
  logger.info({ signal }, "shutting down");
  logger.info(
    {
      signal,
      pid: process.pid,
      uptimeSeconds,
      stoppedAt: new Date().toISOString(),
    },
    "server stop: received shutdown signal, draining scheduler and closing health server",
  );
  logger.info(
    { signal, pid: process.pid, uptimeSeconds },
    "🐻 Bear Metal is wiping honey off the keyboard, packing the laptop into its cave, hanging the 'gone fishing' sign on the PR queue, and shuffling back into hibernation — it logged off, dimmed the lights, set an out-of-office on Slack, and curled up next to a stack of half-read RFCs. See you on the next sprint, reviewers; try not to merge anything spicy without me. 💤🐟📚",
  );
  void scheduler.stop().then(() => {
    server.close(() => {
      logger.info(
        { signal, closedAt: new Date().toISOString(), uptimeSeconds: process.uptime() },
        "server stop: health server socket closed, scheduler drained, exiting cleanly",
      );
      logger.info(
        { signal },
        "🌙 health server closed — Bear Metal has tucked itself in, double-checked that the cave door is locked, whispered 'goodnight, sweet PRs' to the merge queue, and is now officially snoring. Don't wake the bear unless prod is on fire. 💤",
      );
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
