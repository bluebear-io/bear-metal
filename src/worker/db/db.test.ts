import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient, resolveDatabaseConfig } from "./client.js";
import { SqliteClient } from "./sqlite-client.js";
import type { DatabaseClient } from "./types.js";

describe("resolveDatabaseConfig", () => {
  it("returns postgres when DATABASE_URL is set", () => {
    const cfg = resolveDatabaseConfig({ DATABASE_URL: "postgres://u:p@h:5432/db" }, "/root");
    expect(cfg).toEqual({ driver: "postgres", connectionString: "postgres://u:p@h:5432/db" });
  });

  it("accepts postgresql:// scheme", () => {
    const cfg = resolveDatabaseConfig({ DATABASE_URL: "postgresql://h/db" }, "/root");
    expect(cfg.driver).toBe("postgres");
  });

  it("rejects non-postgres DATABASE_URL", () => {
    expect(() => resolveDatabaseConfig({ DATABASE_URL: "mysql://h/db" }, "/root")).toThrow(
      /must start with postgres/,
    );
  });

  it("falls back to sqlite at DATABASE_PATH", () => {
    const cfg = resolveDatabaseConfig({ DATABASE_PATH: "/data/foo.sqlite" }, "/root");
    expect(cfg).toEqual({ driver: "sqlite", path: "/data/foo.sqlite" });
  });

  it("defaults sqlite path to <packageRoot>/bear-metal.sqlite", () => {
    const cfg = resolveDatabaseConfig({}, "/root");
    expect(cfg).toEqual({ driver: "sqlite", path: path.join("/root", "bear-metal.sqlite") });
  });

  it("treats empty DATABASE_URL as unset", () => {
    const cfg = resolveDatabaseConfig({ DATABASE_URL: "" }, "/root");
    expect(cfg.driver).toBe("sqlite");
  });
});

describe("SqliteClient.createTaskInProgress", () => {
  let tmp: string;
  let client: DatabaseClient;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "bear-metal-db-"));
    client = new SqliteClient({ path: path.join(tmp, "test.sqlite") });
    await client.init();
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("inserts a row with status=in_progress and returns its id", async () => {
    const id1 = await client.createTaskInProgress("DEN-1");
    const id2 = await client.createTaskInProgress("DEN-2");
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it("init is idempotent", async () => {
    await client.init();
    await client.init();
    const id = await client.createTaskInProgress("DEN-3");
    expect(id).toBeGreaterThan(0);
  });
});

describe("createDatabaseClient", () => {
  it("creates a working sqlite client by default", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "bear-metal-db-"));
    try {
      const client = await createDatabaseClient({ env: {}, packageRoot: tmp });
      const id = await client.createTaskInProgress("DEN-42");
      expect(id).toBe(1);
      await client.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
