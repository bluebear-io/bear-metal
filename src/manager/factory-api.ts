import { Router, raw, type Request, type Response, type NextFunction } from "express";
import { FactoryTaskConflictError, type DbClient } from "../db/client.js";
import { FactoryRequestError, parseFactoryTaskRequest, type FactoryTaskRecord } from "../factory/task.js";
import type { Logger } from "../shared/logger.js";
import { verifyRequestSignature } from "./request-signature.js";

export const FACTORY_TIMESTAMP_HEADER = "x-factory-request-timestamp";
export const FACTORY_SIGNATURE_HEADER = "x-factory-signature";

/**
 * The workflow factory's task API. Every request, GETs included, is signed over its raw body (empty for
 * GET) with the factory's HMAC key; mount it before any JSON body parser.
 */
export function createFactoryRouter(input: {
  db: DbClient;
  signingSecret: string;
  capabilities: readonly string[];
  logger: Logger;
  /** Starts a worker poll right away instead of waiting for the next interval. */
  wake: () => void;
}): Router {
  if (!input.signingSecret) throw new Error("The factory API requires a signing secret");
  const router = Router();
  router.use(raw({ type: () => true, limit: "1mb" }), (req: Request, res: Response, next: NextFunction) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyRequestSignature(body, req.header(FACTORY_TIMESTAMP_HEADER), req.header(FACTORY_SIGNATURE_HEADER), input.signingSecret)) {
      res.sendStatus(401);
      return;
    }
    next();
  });

  router.get("/capabilities", (_req, res) => {
    res.json({ capabilities: input.capabilities });
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
      const request = parseFactoryTaskRequest(body);
      const { task, created } = await input.db.createFactoryTask(request);
      if (created) {
        input.logger.info({ taskId: task.id, runId: request.runId, role: request.role }, "factory task accepted");
        input.wake();
      }
      res.status(202).json({ id: task.id, status: task.status });
    } catch (err) {
      if (err instanceof FactoryRequestError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof FactoryTaskConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tasks/:id", async (req, res, next) => {
    try {
      const task = await input.db.getFactoryTask(req.params.id);
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
      const task = await input.db.cancelFactoryTask(req.params.id);
      if (!task) {
        res.sendStatus(404);
        return;
      }
      input.logger.info({ taskId: task.id, status: task.status }, "factory task cancel requested");
      res.json(view(task));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function view(task: FactoryTaskRecord) {
  return {
    id: task.id, status: task.status, result: task.result, error: task.error,
    createdAt: task.createdAt, startedAt: task.startedAt, endedAt: task.endedAt,
  };
}
