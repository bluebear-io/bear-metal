import { describe, it, expect } from "vitest";
import { DEFAULT_HOURS_PER_COMPLEXITY, loadBackendConfig } from "./config.js";

describe("loadBackendConfig", () => {
  it("reads DB path, port, and log level from env", () => {
    const cfg = loadBackendConfig({
      BEAR_METAL_DB_PATH: "/tmp/x.db",
      BACKEND_PORT: "4000",
      LOG_LEVEL: "debug",
    });
    expect(cfg).toEqual({
      dbPath: "/tmp/x.db",
      port: 4000,
      logLevel: "debug",
      ingestToken: "",
      hoursPerComplexity: DEFAULT_HOURS_PER_COMPLEXITY,
    });
  });

  it("defaults HOURS_PER_COMPLEXITY when env var is unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db" });
    expect(cfg.hoursPerComplexity).toEqual(DEFAULT_HOURS_PER_COMPLEXITY);
  });

  it("accepts a full HOURS_PER_COMPLEXITY_JSON override", () => {
    const cfg = loadBackendConfig({
      BEAR_METAL_DB_PATH: "/tmp/x.db",
      HOURS_PER_COMPLEXITY_JSON: '{"1":0.25,"2":1,"3":2,"4":4,"5":8}',
    });
    expect(cfg.hoursPerComplexity).toEqual({ 1: 0.25, 2: 1, 3: 2, 4: 4, 5: 8 });
  });

  it("rejects HOURS_PER_COMPLEXITY_JSON missing a level", () => {
    expect(() =>
      loadBackendConfig({
        BEAR_METAL_DB_PATH: "/tmp/x.db",
        HOURS_PER_COMPLEXITY_JSON: '{"1":0.5,"2":1,"3":2,"4":4}',
      }),
    ).toThrow(/HOURS_PER_COMPLEXITY_JSON/);
  });

  it("rejects HOURS_PER_COMPLEXITY_JSON with non-positive values", () => {
    expect(() =>
      loadBackendConfig({
        BEAR_METAL_DB_PATH: "/tmp/x.db",
        HOURS_PER_COMPLEXITY_JSON: '{"1":0,"2":1,"3":2,"4":4,"5":8}',
      }),
    ).toThrow(/HOURS_PER_COMPLEXITY_JSON/);
  });

  it("rejects malformed HOURS_PER_COMPLEXITY_JSON", () => {
    expect(() =>
      loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", HOURS_PER_COMPLEXITY_JSON: "not json" }),
    ).toThrow(/HOURS_PER_COMPLEXITY_JSON/);
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
});
