import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("manager infrastructure config", () => {
  it("loads infrastructure defaults without legacy customization variables", () => {
    process.env = {};
    expect(loadConfig()).toEqual({ workerConcurrency: 5, pollIntervalMs: 60_000, backendPort: 3100, logLevel: "info", logPretty: false, testTicketId: null, apiOnly: false, runMode: "normal", taskHeartbeatIntervalMs: 30_000, taskStaleAfterMs: 300_000, taskMaxReclaims: 3 });
  });
  it("rejects invalid positive infrastructure values", () => {
    process.env.WORKER_CONCURRENCY = "0";
    expect(() => loadConfig()).toThrow("WORKER_CONCURRENCY must be a positive integer");
  });
  it("accepts Slack-only mode and rejects unknown modes", () => {
    process.env.BEAR_METAL_RUN_MODE = "slack_only";
    expect(loadConfig().runMode).toBe("slack_only");
    process.env.BEAR_METAL_RUN_MODE = "unsafe";
    expect(() => loadConfig()).toThrow("BEAR_METAL_RUN_MODE");
    process.env.BEAR_METAL_RUN_MODE = "slack_only";
    process.env.TEST_TICKET_ID = "DEN-1";
    expect(() => loadConfig()).toThrow("TEST_TICKET_ID cannot be used");
  });
});
