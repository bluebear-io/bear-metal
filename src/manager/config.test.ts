import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const REQUIRED = {
  LINEAR_API_TOKEN: "lin_token",
  GITHUB_TOKEN: "gh_token",
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "widgets",
};

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
  for (const key of [
    "LINEAR_API_TOKEN",
    "LINEAR_LABEL",
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "WORKER_CONCURRENCY",
    "POLL_INTERVAL_MS",
    "PORT",
    "LOG_LEVEL",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = snapshot;
});

describe("loadConfig", () => {
  it("loads required values and applies defaults", () => {
    Object.assign(process.env, REQUIRED);
    const config = loadConfig();
    expect(config.linearApiToken).toBe("lin_token");
    expect(config.githubOwner).toBe("acme");
    expect(config.linearLabel).toBe("bear-metal");
    expect(config.workerConcurrency).toBe(2);
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("throws when a required variable is missing", () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.GITHUB_TOKEN;
    expect(() => loadConfig()).toThrow(/GITHUB_TOKEN/);
  });

  it("throws on a non-positive-integer numeric variable", () => {
    Object.assign(process.env, REQUIRED, { WORKER_CONCURRENCY: "0" });
    expect(() => loadConfig()).toThrow(/WORKER_CONCURRENCY/);
  });

  it("honors overrides for optional variables", () => {
    Object.assign(process.env, REQUIRED, { LINEAR_LABEL: "robo", WORKER_CONCURRENCY: "5" });
    const config = loadConfig();
    expect(config.linearLabel).toBe("robo");
    expect(config.workerConcurrency).toBe(5);
  });
});
