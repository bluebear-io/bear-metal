import { describe, it, expect } from "vitest";
import { loadBackendConfig } from "./config.js";

describe("loadBackendConfig", () => {
  it("reads DB path, port, and log level from env", () => {
    const cfg = loadBackendConfig({
      BEAR_METAL_DB_PATH: "/tmp/x.db",
      BACKEND_PORT: "4000",
      LOG_LEVEL: "debug",
    });
    expect(cfg).toEqual({ dbPath: "/tmp/x.db", port: 4000, logLevel: "debug", ingestToken: "", monthlyBudgetUsd: null });
  });

  it("defaults the port to 3100 when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db" });
    expect(cfg.port).toBe(3100);
  });

  it("defaults the log level to info when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db" });
    expect(cfg.logLevel).toBe("info");
  });

  it("fails fast when the DB path is missing (no silent default)", () => {
    expect(() => loadBackendConfig({})).toThrow(/BEAR_METAL_DB_PATH/);
  });

  it("fails fast when the port is set but not a positive integer (no silent NaN)", () => {
    expect(() => loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", BACKEND_PORT: "abc" })).toThrow(
      /BACKEND_PORT/,
    );
  });

  it("parses MONTHLY_BUDGET_USD when set", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", MONTHLY_BUDGET_USD: "500" });
    expect(cfg.monthlyBudgetUsd).toBe(500);
  });

  it("fails fast when MONTHLY_BUDGET_USD is invalid", () => {
    expect(() => loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", MONTHLY_BUDGET_USD: "oops" })).toThrow(
      /MONTHLY_BUDGET_USD/,
    );
  });
});
