import { Router, raw, type Request, type Response, type NextFunction } from "express";
import { ApiTaskConflictError, type DbClient } from "../db/client.js";
import { ApiTaskRequestError, parseApiTaskRequest, type ApiTaskRecord } from "../task-api/request.js";
import type { Logger } from "../shared/logger.js";
import { verifyRequestSignature } from "./request-signature.js";

export const TASK_API_TIMESTAMP_HEADER = "x-bear-metal-request-timestamp";
export const TASK_API_SIGNATURE_HEADER = "x-bear-metal-signature";

/**
 * Runs tasks without a Linear ticket. Every request, GETs included, is signed over its raw body (empty for GET);
 * mount it before any JSON body parser.
 */
export function createTaskApiRouter(input: {
  db: DbClient;
  signingSecret: string;
  logger: Logger;
  /** Starts a worker poll right away instead of waiting for the next interval. */
  wake: () => void;
}): Router {
  if (!input.signingSecret) throw new Error("The task API requires a signing secret");
  const router = Router();
  router.use(raw({ type: () => true, limit: "1mb" }), (req: Request, res: Response, next: NextFunction) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyRequestSignature(body, req.header(TASK_API_TIMESTAMP_HEADER), req.header(TASK_API_SIGNATURE_HEADER), input.signingSecret)) {
      res.sendStatus(401);
      return;
    }
    next();
  });

  router.post("/tasks", async (req, res, next) => {
    try {
      let body: unknown;
      try {
        body = JSON.parse((req.body as Buffer).toString("utf8"));
      } catch {
        res.status(400).json({ error: "request body must be JSON" });
        return;
      }
      const request = parseApiTaskRequest(body);
      const { task, created } = await input.db.createApiTask(request);
      if (created) {
        input.logger.info({ taskId: task.id, profile: request.profile, repository: request.repository }, "API task accepted");
        input.wake();
      }
      res.status(202).json({ id: task.id, status: task.status });
    } catch (err) {
      if (err instanceof ApiTaskRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof ApiTaskConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tasks/:id", async (req, res, next) => {
    try {
      const task = await input.db.getApiTask(req.params.id);
      if (!task) {
        res.sendStatus(404);
        return;
      }
      res.json(view(task));
    } catch (err) {
      next(err);
    }
  });

  router.post("/tasks/:id/cancel", async (req, res, next) => {
    try {
      const task = await input.db.cancelApiTask(req.params.id);
      if (!task) {
        res.sendStatus(404);
        return;
      }
      input.logger.info({ taskId: task.id, status: task.status }, "API task cancel requested");
      res.json(view(task));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function view({ request: _request, ...task }: ApiTaskRecord) {
  return task;
}
