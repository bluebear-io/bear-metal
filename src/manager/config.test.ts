import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("manager infrastructure config", () => {
  it("loads infrastructure defaults without legacy customization variables", () => {
    process.env = {};
    expect(loadConfig()).toEqual({ workerConcurrency: 5, pollIntervalMs: 60_000, backendPort: 3100, logLevel: "info", logPretty: false, testTicketId: null, apiOnly: false, taskHeartbeatIntervalMs: 30_000, taskStaleAfterMs: 300_000, taskMaxReclaims: 3 });
  });
  it("rejects invalid positive infrastructure values", () => {
    process.env.WORKER_CONCURRENCY = "0";
    expect(() => loadConfig()).toThrow("WORKER_CONCURRENCY must be a positive integer");
  });
});
