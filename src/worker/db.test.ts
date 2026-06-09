import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BearMetalDatabase, createDatabase, TASK_STATUS } from "./db.js";

let tmp: string;
let db: BearMetalDatabase;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bear-metal-db-"));
});

afterEach(async () => {
  await db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createDatabase", () => {
  it("defaults to a local sqlite file when DATABASE_URL is unset", async () => {
    const sqlitePath = join(tmp, "test.sqlite");
    db = createDatabase({ env: { SQLITE_PATH: sqlitePath } });
    await db.init();

    await db.recordTaskInProgress("DEN-1");

    const rows = await db.kysely.selectFrom("tasks").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticket_id: "DEN-1", status: TASK_STATUS.IN_PROGRESS });
  });

  it("rejects non-postgres DATABASE_URL schemes (no silent fallback to sqlite)", () => {
    expect(() => createDatabase({ env: { DATABASE_URL: "mysql://user:pass@host/db" } })).toThrow(
      /postgres/i,
    );
  });

  it("accepts both postgres:// and postgresql:// schemes", () => {
    // We can't connect to a real server here, so we just assert construction
    // doesn't throw on the scheme check. The Pool is lazy and won't connect.
    expect(() => {
      const created = createDatabase({ env: { DATABASE_URL: "postgres://u:p@localhost:5432/x" } });
      void created.close();
    }).not.toThrow();
    expect(() => {
      const created = createDatabase({ env: { DATABASE_URL: "postgresql://u:p@localhost:5432/x" } });
      void created.close();
    }).not.toThrow();
  });
});

describe("BearMetalDatabase.recordTaskInProgress", () => {
  it("is idempotent and refreshes updated_at on conflict", async () => {
    const sqlitePath = join(tmp, "idem.sqlite");
    db = createDatabase({ env: { SQLITE_PATH: sqlitePath } });
    await db.init();

    await db.recordTaskInProgress("DEN-42");
    const first = await db.kysely.selectFrom("tasks").selectAll().executeTakeFirstOrThrow();

    // Ensure a measurable timestamp delta.
    await new Promise((r) => setTimeout(r, 5));

    await db.recordTaskInProgress("DEN-42");
    const rows = await db.kysely.selectFrom("tasks").selectAll().execute();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected a row");
    expect(row.status).toBe(TASK_STATUS.IN_PROGRESS);
    expect(row.created_at).toBe(first.created_at);
    expect(row.updated_at >= first.updated_at).toBe(true);
  });
});
