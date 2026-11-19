import { Router, raw, type Request, type Response, type NextFunction } from "express";
import { ApiTaskConflictError, type DbClient } from "../db/client.js";
import { ApiTaskRequestError, parseApiTaskRequest, type ApiTaskRecord, type ApiTaskRequest } from "../task-api/request.js";
import type { Logger } from "../shared/logger.js";
import { verifyRequestSignature } from "./request-signature.js";
import { stopTicketWork, type TicketHandBack } from "./api-task-worker.js";

export const TASK_API_TIMESTAMP_HEADER = "x-bear-metal-request-timestamp";
export const TASK_API_SIGNATURE_HEADER = "x-bear-metal-signature";

/** The Linear operations a coding task needs to hand its ticket to the scheduler. */
export interface TicketDelegation extends TicketHandBack {
  getAgentId(): Promise<string>;
  getTicket(id: string): Promise<{ id: string; delegate: { id: string } | null }>;
  findUserIdByEmail(email: string): Promise<string>;
  assignAndDelegate(ticketIssueId: string, assigneeId: string): Promise<void>;
}

class TicketRequestError extends Error {
  constructor(readonly status: 400 | 409 | 502, message: string) {
    super(message);
  }
}

/**
 * Runs tasks through a signed API. Every request, GETs included, is signed over its method, full path and raw body (empty for GET);
 * mount it before any JSON body parser. Without `tickets`, coding requests are refused.
 */
export function createTaskApiRouter(input: {
  db: DbClient;
  signingSecret: string;
  logger: Logger;
  tickets?: TicketDelegation;
  /** Starts a worker poll right away instead of waiting for the next interval. */
  wake: () => void;
}): Router {
  if (!input.signingSecret) throw new Error("The task API requires a signing secret");
  const router = Router();
  router.use(raw({ type: () => true, limit: "1mb" }), (req: Request, res: Response, next: NextFunction) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyRequestSignature(body, req.header(TASK_API_TIMESTAMP_HEADER), req.header(TASK_API_SIGNATURE_HEADER), input.signingSecret, `${req.method} ${req.originalUrl}`)) {
      input.logger.warn({ method: req.method, path: req.originalUrl, ip: req.ip }, "Task API request signature rejected");
      res.sendStatus(401);
      return;
    }
    next();
  });

  /** Creates a coding task and delegates its ticket; a retry of a created task returns it without touching Linear. */
  async function createCodingTask(request: ApiTaskRequest & { ticketId: string }): Promise<{ task: ApiTaskRecord; created: boolean }> {
    const tickets = input.tickets;
    if (!tickets) throw new TicketRequestError(400, "Coding tasks need the Linear scheduler, which is off");
    const existing = await input.db.getApiTaskByKey(request.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
        throw new ApiTaskConflictError(`Idempotency key ${request.idempotencyKey} was used with a different request`);
      }
      return { task: existing, created: false };
    }
    let ticket: { id: string; delegate: { id: string } | null };
    try {
      ticket = await tickets.getTicket(request.ticketId);
    } catch (err) {
      throw new TicketRequestError(400, `Cannot read ticket ${request.ticketId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ticket.delegate?.id === await tickets.getAgentId() || await input.db.getTrackedSlot(ticket.id)) {
      throw new TicketRequestError(409, `Ticket ${request.ticketId} is already delegated to Bear Metal`);
    }
    let assigneeId: string;
    try {
      assigneeId = await tickets.findUserIdByEmail(request.owner);
    } catch (err) {
      throw new TicketRequestError(400, `Cannot find the owner in Linear: ${err instanceof Error ? err.message : String(err)}`);
    }
    const created = await input.db.createApiTask(request, ticket.id);
    if (!created.created) return created;
    // Started before delegating, so a crash in between leaves a task that cancel and its deadline can still stop.
    try {
      await input.db.startTicketApiTask(created.task.id);
    } catch (err) {
      await input.db.failQueuedApiTask(created.task.id, `Cannot start the coding task: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    try {
      await tickets.assignAndDelegate(ticket.id, assigneeId);
    } catch (err) {
      const error = `Cannot delegate ticket ${request.ticketId}: ${err instanceof Error ? err.message : String(err)}`;
      await stopTicketWork(input.db, tickets, ticket.id, error);
      await input.db.finishApiTask(created.task.id, { status: "failed", result: null, error });
      throw new TicketRequestError(502, error);
    }
    return { task: (await input.db.getApiTask(created.task.id))!, created: true };
  }

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
      const { task, created } = request.ticketId !== undefined
        ? await createCodingTask(request as ApiTaskRequest & { ticketId: string })
        : await input.db.createApiTask(request);
      if (created) {
        input.logger.info({ taskId: task.id, profile: request.profile.id, ticketId: request.ticketId, repository: request.repository }, "API task accepted");
        if (!request.ticketId) input.wake();
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
      if (err instanceof TicketRequestError) {
        res.status(err.status).json({ error: err.message });
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
      // Repeated while the task still owns its ticket's slot, so a failed hand-back can be retried.
      if (task.status === "canceled" && task.ticketIssueId && (await input.db.getTicketApiTask(task.ticketIssueId))?.id === task.id) {
        if (!input.tickets) throw new Error(`API task ${task.id} has a ticket, but the Linear scheduler is off`);
        await stopTicketWork(input.db, input.tickets, task.ticketIssueId, "Canceled through the task API");
      }
      input.logger.info({ taskId: task.id, status: task.status }, "API task cancel requested");
      res.json(view(task));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function view({ request: _request, ticketIssueId: _ticketIssueId, ...task }: ApiTaskRecord) {
  return task;
}
