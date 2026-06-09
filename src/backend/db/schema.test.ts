import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";

describe("schema", () => {
  it("exports all six tables", () => {
    expect(Object.keys(schema).sort()).toEqual(
      ["ciRuns", "events", "pullRequests", "runs", "tickets", "workers"].sort(),
    );
  });

  it("can be created in a SQLite database", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    db.run(sql`CREATE TABLE tickets (id TEXT PRIMARY KEY)`);
    const rows = db.all(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    expect(rows).toContainEqual({ name: "tickets" });
    sqlite.close();
  });
});
