import type { RequestHandler } from "express";

/**
 * No-op auth seam. Local-only MVP has no auth; a real implementation slots in here
 * later (e.g. WorkOS) without touching route handlers.
 */
export const authStub: RequestHandler = (_req, _res, next) => next();
