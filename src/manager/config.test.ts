import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const REQUIRED = {
  LINEAR_API_TOKEN: "lin_token",
  LINEAR_ASSIGNEE_ID: "user-1",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_INSTALLATION_ID: "67890",
};

let snapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  snapshot = { ...process.env };
  for (const key of [
    "LINEAR_API_TOKEN",
    "LINEAR_ASSIGNEE_ID",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
    "DATABASE_URL",
    "WORKER_CONCURRENCY",
    "POLL_INTERVAL_MS",
    "BACKEND_PORT",
    "LOG_LEVEL",
    "TEST_TICKET_ID",
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
    expect(config.linearAssigneeId).toBe("user-1");
    expect(config.githubAppId).toBe(12_345);
    expect(config.githubAppInstallationId).toBe(67_890);
    expect(config.databaseUrl).toBe("sqlite:./data/bear-metal.sqlite");
    expect(config.workerConcurrency).toBe(5);
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.backendPort).toBe(3100);
    expect(config.logLevel).toBe("info");
    expect(config.testTicketId).toBeNull();
  });

  it("reads TEST_TICKET_ID when set", () => {
    Object.assign(process.env, REQUIRED, { TEST_TICKET_ID: "DEN-9999" });
    expect(loadConfig().testTicketId).toBe("DEN-9999");
  });

  it("defaults testTicketId to null when TEST_TICKET_ID is unset", () => {
    Object.assign(process.env, REQUIRED);
    expect(loadConfig().testTicketId).toBeNull();
  });

  it("restores real newlines in the App private key", () => {
    Object.assign(process.env, REQUIRED);
    expect(loadConfig().githubAppPrivateKey).toContain("\n");
    expect(loadConfig().githubAppPrivateKey).not.toContain("\\n");
  });

  it("throws when a required variable is missing", () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.LINEAR_ASSIGNEE_ID;
    expect(() => loadConfig()).toThrow(/LINEAR_ASSIGNEE_ID/);
  });

  it("throws on a non-positive-integer numeric variable", () => {
    Object.assign(process.env, REQUIRED, { WORKER_CONCURRENCY: "0" });
    expect(() => loadConfig()).toThrow(/WORKER_CONCURRENCY/);
  });

  it("honors overrides for optional variables", () => {
    Object.assign(process.env, REQUIRED, { DATABASE_URL: "postgres://db.example/app", WORKER_CONCURRENCY: "5" });
    expect(loadConfig().databaseUrl).toBe("postgres://db.example/app");
    expect(loadConfig().workerConcurrency).toBe(5);
  });
});
