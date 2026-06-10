import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { parse as parseConnectionString } from "pg-connection-string";
import * as schema from "./schema.js";
import { openReadOnlyDb, openReadWriteDb } from "./client.js";
import { detectDialect } from "../config.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("openReadOnlyDb", () => {
  it("throws a clear error when the DB file is missing (fail-fast)", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-"));
    const missing = join(dir, "nope.db");
    expect(() => openReadOnlyDb(missing)).toThrow(/database file not found/i);
  });

  it("opens an existing DB read-only and rejects writes", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-"));
    const path = join(dir, "ok.db");
    const seed = new Database(path);
    seed.exec("CREATE TABLE t (id TEXT)");
    seed.close();

    const { sqlite } = openReadOnlyDb(path);
    expect(() => sqlite.exec("INSERT INTO t VALUES ('x')")).toThrow();
    sqlite.close();
  });
});

describe("openReadWriteDb", () => {
  it("opens an existing file writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-rw-"));
    const path = join(dir, "dash.sqlite");
    const seed = drizzle(new Database(path), { schema });
    migrate(seed, { migrationsFolder: "./src/backend/db/migrations" });

    const { db, sqlite } = openReadWriteDb(path);
    db.insert(schema.workers)
      .values({ id: "w1", name: "n", status: "idle", currentRunId: null, lastHeartbeatAt: null, startedAt: new Date(1), updatedAt: new Date(1) })
      .run();
    const rows = db.select().from(schema.workers).all();
    sqlite.close();
    expect(rows).toHaveLength(1);
  });

  it("fails fast when the file is missing", () => {
    expect(() => openReadWriteDb("/no/such/file.sqlite")).toThrow(/not found/);
  });

  it("does not enforce foreign keys (best-effort out-of-order writes)", () => {
    dir = mkdtempSync(join(tmpdir(), "bm-fk-"));
    const path = join(dir, "dash.sqlite");
    const seed = drizzle(new Database(path), { schema });
    migrate(seed, { migrationsFolder: "./src/backend/db/migrations" });

    const { db, sqlite } = openReadWriteDb(path);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(0);
    // a child row referencing a non-existent ticket must NOT throw
    expect(() =>
      db.insert(schema.runs).values({
        id: "r1", ticketId: "missing", attemptNumber: 1, workerId: null,
        trigger: "new", status: "dispatched", contextJson: null,
        startedAt: null, endedAt: null, stopReason: null, error: null, createdAt: new Date(1),
      }).run()
    ).not.toThrow();
    sqlite.close();
  });
});

/**
 * Postgres connection-string contract. We can't dial a real RDS instance from outside the VPC,
 * so we verify the *upstream* contract instead: when the backend is given a `postgres://...` URL,
 * it dispatches to the PG factory branch, and pg.Pool will receive a correctly parsed config
 * (password URL-decoded, sslmode honored). pg.Pool itself uses `pg-connection-string` internally,
 * so asserting the parser output is equivalent to asserting what pg.Pool will see.
 *
 * Never put a real secret in source. Production credentials come from `BEAR_METAL_DATABASE_URL`
 * at runtime; tests use synthetic values that exercise the same parsing edge cases.
 */
describe("postgres URL routing", () => {
  it("classifies postgres:// and postgresql:// as the postgres dialect", () => {
    expect(detectDialect("postgres://u:p@h:5432/db")).toBe("postgres");
    expect(detectDialect("postgresql://u:p@h:5432/db")).toBe("postgres");
  });

  it("URL-decodes percent-escaped passwords (matches pg.Pool's behavior)", () => {
    // Synthetic password containing the same URL-reserved bytes a real password might
    // contain (`]`, `[`, `)`) so the decode path is exercised end-to-end.
    const decoded = "p@ss]wo[rd)123";
    const encoded = encodeURIComponent(decoded);
    const cfg = parseConnectionString(`postgres://u:${encoded}@host.example:5432/db?sslmode=no-verify`);
    expect(cfg.password).toBe(decoded);
    expect(cfg.user).toBe("u");
    expect(cfg.host).toBe("host.example");
    expect(cfg.port).toBe("5432");
    expect(cfg.database).toBe("db");
  });

  it("honors sslmode=no-verify by disabling certificate verification (RDS-friendly)", () => {
    const cfg = parseConnectionString("postgres://u:p@host:5432/db?sslmode=no-verify");
    // pg-connection-string maps `no-verify` to ssl: { rejectUnauthorized: false }.
    // pg.Pool consumes the same `ssl` field, so this is what the backend will send to the server.
    expect(typeof cfg.ssl).toBe("object");
    expect((cfg.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(false);
  });
});
