import { mkdir } from "node:fs/promises";
import { createLogger } from "../shared/index.js";
import { getPackageRoot, runCloneScript, workspaceForTicket } from "./clone.js";
import { createDatabaseClient } from "./db/index.js";
import type { DatabaseClient } from "./db/index.js";
import { runPiWorker } from "./pi.js";
import type { DispatchResult, DispatchState, PullRequestRef, WorkerInputContext, WorkerIntegrations } from "./types.js";

export type { DispatchResult, DispatchState, PullRequestRef };

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:dispatch",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

export interface DispatchInput {
  state: DispatchState;
  ticketId: string;
  pr?: PullRequestRef | null;
  integrations: WorkerIntegrations;
  packageRoot?: string;
  /** Delete and re-clone if the workspace already exists. Useful for re-running the same ticket. */
  force?: boolean;
  /**
   * Optional injected DatabaseClient. Tests pass an in-memory client; production leaves
   * this unset and we lazily create one from env vars (DATABASE_URL or local sqlite).
   */
  db?: DatabaseClient;
}

export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { state, ticketId, integrations } = input;
  const pr = input.pr ?? null;
  validateDispatchInputs(state, ticketId, pr);

  const { github, linear } = integrations;
  const packageRoot = input.packageRoot ?? getPackageRoot(import.meta.url);
  const workspaceDir = workspaceForTicket(packageRoot, ticketId);

  await mkdir(workspaceDir, { recursive: true });

  logger.info({ ticketId, state, hasPr: pr !== null, workspaceDir }, "dispatch starting");

  // Record the task as in_progress before we kick off any external work. Use an
  // injected client when provided (tests); otherwise build one from env and close it
  // at the end of this dispatch so we don't leak connections across tickets.
  const ownsDb = input.db === undefined;
  const db = input.db ?? (await createDatabaseClient({ packageRoot }));
  try {
    if (state === "new") {
      const taskId = await db.createTaskInProgress(ticketId);
      logger.info({ ticketId, taskId }, "task recorded as in_progress");
    }
  } catch (err) {
    if (ownsDb) {
      await db.close().catch(() => undefined);
    }
    throw err;
  }

  const [ticket, pullRequest, cloneScript] = await Promise.all([
    linear.getTicketContext(ticketId).then((t) => {
      logger.info({ ticketId }, "linear ticket fetched");
      return t;
    }),
    pr
      ? github.getPullRequestContext(pr).then((p) => {
          logger.info({ owner: pr.owner, repo: pr.repo, number: pr.number }, "github PR context fetched");
          return p;
        })
      : Promise.resolve(null),
    runCloneScript({ packageRoot, workspaceDir, force: input.force }).then((r) => {
      logger.info({ workspaceDir, scriptPath: r.scriptPath }, "clone script completed");
      return r;
    }),
  ]);

  const context: WorkerInputContext = {
    state,
    ticketId,
    pr,
    ticket,
    pullRequest,
    cloneScript,
  };

  logger.info({ ticketId, workspaceDir }, "starting pi worker session");
  try {
    const result = await runPiWorker({ context, github, linear });
    logger.info({ ticketId, status: result.status }, "pi worker session completed");
    return result;
  } finally {
    if (ownsDb) {
      await db.close().catch((err) => logger.warn({ err }, "db close failed"));
    }
  }
}

export function validateDispatchInputs(state: DispatchState, ticketId: string, pr: PullRequestRef | null): void {
  if (state !== "new" && state !== "iteration") {
    throw new Error(`Unsupported dispatch state: ${String(state)}`);
  }
  if (!ticketId.trim()) {
    throw new Error("ticketId is required");
  }
  if (state === "new" && pr !== null) {
    throw new Error('state "new" must not include a pull request');
  }
  if (state === "iteration" && pr === null) {
    throw new Error('state "iteration" requires a pull request');
  }
}
