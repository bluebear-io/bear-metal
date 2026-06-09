import { Router, type RequestHandler } from "express";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { upsertTicket, upsertWorker, upsertRun, upsertPullRequest, upsertCiRun, insertEvent } from "../db/writer.js";

type Db = BetterSQLite3Database<typeof schema>;

class BadPayload extends Error {}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new BadPayload(`${k} must be a non-empty string`);
  return v;
}
function strOrNull(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "string") throw new BadPayload(`${k} must be a string or null`);
  return v;
}
function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadPayload(`${k} must be a number`);
  return v;
}
function numOrNull(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadPayload(`${k} must be a number or null`);
  return v;
}
function bool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new BadPayload(`${k} must be a boolean`);
  return v;
}
function strArray(o: Record<string, unknown>, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadPayload(`${k} must be a string[]`);
  return v as string[];
}
function enumVal<T extends readonly string[]>(o: Record<string, unknown>, k: string, vals: T): T[number] {
  const v = o[k];
  if (typeof v !== "string" || !(vals as readonly string[]).includes(v)) throw new BadPayload(`${k} must be one of: ${vals.join(", ")}`);
  return v as T[number];
}
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadPayload("body must be a JSON object");
  return body as Record<string, unknown>;
}

export function createIngestRouter(db: Db, token: string): Router {
  const router = Router();

  const requireToken: RequestHandler = (req, res, next) => {
    const header = req.header("authorization") ?? "";
    if (header !== `Bearer ${token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const handle = (fn: (body: Record<string, unknown>, id?: string) => void): RequestHandler => (req, res) => {
    try {
      fn(asObject(req.body), req.params.id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof BadPayload) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  };

  router.put("/tickets/:id", requireToken, handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertTicket(db, {
      id: bodyId, identifier: str(b, "identifier"), title: str(b, "title"),
      description: strOrNull(b, "description"), url: str(b, "url"), branchName: str(b, "branchName"),
      linearStatusName: str(b, "linearStatusName"), linearStatusType: str(b, "linearStatusType"),
      labels: strArray(b, "labels"), bmStatus: enumVal(b, "bmStatus", schema.tickets.bmStatus.enumValues),
      attemptCount: num(b, "attemptCount"), maxAttempts: num(b, "maxAttempts"),
      createdAt: num(b, "createdAt"), updatedAt: num(b, "updatedAt"), completedAt: numOrNull(b, "completedAt"),
    });
  }));

  router.put("/workers/:id", requireToken, handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertWorker(db, {
      id: bodyId, name: str(b, "name"), status: enumVal(b, "status", schema.workers.status.enumValues),
      currentRunId: strOrNull(b, "currentRunId"), lastHeartbeatAt: numOrNull(b, "lastHeartbeatAt"),
      startedAt: num(b, "startedAt"), updatedAt: num(b, "updatedAt"),
    });
  }));

  router.put("/runs/:id", requireToken, handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertRun(db, {
      id: bodyId, ticketId: str(b, "ticketId"), attemptNumber: num(b, "attemptNumber"),
      workerId: strOrNull(b, "workerId"), trigger: enumVal(b, "trigger", schema.runs.trigger.enumValues),
      status: enumVal(b, "status", schema.runs.status.enumValues), contextJson: strOrNull(b, "contextJson"),
      startedAt: numOrNull(b, "startedAt"), endedAt: numOrNull(b, "endedAt"),
      stopReason: b.stopReason === null ? null : enumVal(b, "stopReason", schema.runs.stopReason.enumValues),
      error: strOrNull(b, "error"),
      promptTokens: numOrNull(b, "promptTokens"),
      completionTokens: numOrNull(b, "completionTokens"),
      modelName: strOrNull(b, "modelName"),
      provider: strOrNull(b, "provider"),
      createdAt: num(b, "createdAt"),
    });
  }));

  router.put("/pull-requests/:id", requireToken, handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertPullRequest(db, {
      id: bodyId, ticketId: str(b, "ticketId"), number: num(b, "number"), title: str(b, "title"),
      headRef: str(b, "headRef"), state: enumVal(b, "state", schema.pullRequests.state.enumValues),
      draft: bool(b, "draft"), merged: bool(b, "merged"), url: str(b, "url"),
      lastRunId: strOrNull(b, "lastRunId"), createdAt: num(b, "createdAt"), updatedAt: num(b, "updatedAt"),
    });
  }));

  router.put("/ci-runs/:id", requireToken, handle((b, id) => {
    const bodyId = str(b, "id");
    if (bodyId !== id) throw new BadPayload("path id and body id must match");
    upsertCiRun(db, {
      id: bodyId, ticketId: str(b, "ticketId"), runId: str(b, "runId"), prId: strOrNull(b, "prId"),
      status: enumVal(b, "status", schema.ciRuns.status.enumValues), url: strOrNull(b, "url"),
      summary: strOrNull(b, "summary"), createdAt: num(b, "createdAt"), completedAt: numOrNull(b, "completedAt"),
    });
  }));

  router.post("/events", requireToken, handle((b) => {
    insertEvent(db, {
      ticketId: strOrNull(b, "ticketId"), runId: strOrNull(b, "runId"), workerId: strOrNull(b, "workerId"),
      source: enumVal(b, "source", schema.events.source.enumValues),
      type: enumVal(b, "type", schema.events.type.enumValues),
      summary: str(b, "summary"), payloadJson: strOrNull(b, "payloadJson"), createdAt: num(b, "createdAt"),
    });
  }));

  return router;
}
