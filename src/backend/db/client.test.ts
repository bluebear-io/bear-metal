import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openReadOnlyDb } from "./client.js";

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
