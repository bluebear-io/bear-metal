import type { DispatchUsage } from "./types.js";

export class WorkerSessionError extends Error {
  constructor(cause: unknown, readonly usage: DispatchUsage | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WorkerSessionError";
  }
}
