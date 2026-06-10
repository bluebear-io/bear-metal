import { describe, it, expect } from "vitest";
import { detectDialect, loadBackendConfig } from "./config.js";

describe("detectDialect", () => {
  it("recognizes sqlite:", () => {
    expect(detectDialect("sqlite:./x.db")).toBe("sqlite");
  });

  it("recognizes postgres:// and postgresql://", () => {
    expect(detectDialect("postgres://u:p@h:5432/db")).toBe("postgres");
    expect(detectDialect("postgresql://u:p@h:5432/db")).toBe("postgres");
  });

  it("throws on unknown schemes", () => {
    expect(() => detectDialect("mysql://x")).toThrow(/Unsupported/);
    expect(() => detectDialect("./bare-path.db")).toThrow(/Unsupported/);
  });
});

describe("loadBackendConfig", () => {
  it("reads database URL, port, and log level from env", () => {
    const cfg = loadBackendConfig({
      BEAR_METAL_DATABASE_URL: "sqlite:/tmp/x.db",
      BACKEND_PORT: "4000",
      LOG_LEVEL: "debug",
    });
    expect(cfg).toEqual({
      databaseUrl: "sqlite:/tmp/x.db",
      dialect: "sqlite",
      port: 4000,
      logLevel: "debug",
      ingestToken: "",
    });
  });

  it("returns dialect=postgres for a postgres URL", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DATABASE_URL: "postgres://u:p@h:5432/db" });
    expect(cfg.dialect).toBe("postgres");
  });

  it("defaults the port to 3100 when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DATABASE_URL: "sqlite:/tmp/x.db" });
    expect(cfg.port).toBe(3100);
  });

  it("defaults the log level to info when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DATABASE_URL: "sqlite:/tmp/x.db" });
    expect(cfg.logLevel).toBe("info");
  });

  it("fails fast when the DB URL is missing (no silent default)", () => {
    expect(() => loadBackendConfig({})).toThrow(/BEAR_METAL_DATABASE_URL/);
  });

  it("fails fast when the URL scheme is unsupported", () => {
    expect(() => loadBackendConfig({ BEAR_METAL_DATABASE_URL: "mysql://x" })).toThrow(/Unsupported/);
  });

  it("fails fast when the port is set but not a positive integer (no silent NaN)", () => {
    expect(() =>
      loadBackendConfig({ BEAR_METAL_DATABASE_URL: "sqlite:/tmp/x.db", BACKEND_PORT: "abc" }),
    ).toThrow(/BACKEND_PORT/);
  });
});
