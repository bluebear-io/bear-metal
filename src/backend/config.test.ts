import { describe, it, expect } from "vitest";
import { loadBackendConfig } from "./config.js";

describe("loadBackendConfig", () => {
  it("reads DB path and port from env", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db", BACKEND_PORT: "4000" });
    expect(cfg).toEqual({ dbPath: "/tmp/x.db", port: 4000 });
  });

  it("defaults the port to 3100 when unset", () => {
    const cfg = loadBackendConfig({ BEAR_METAL_DB_PATH: "/tmp/x.db" });
    expect(cfg.port).toBe(3100);
  });

  it("fails fast when the DB path is missing (no silent default)", () => {
    expect(() => loadBackendConfig({})).toThrow(/BEAR_METAL_DB_PATH/);
  });
});
