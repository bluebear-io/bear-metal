import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { seedMockData } from "./seed.js";

function freshDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./src/backend/db/migrations" });
  return db;
}

describe("seedMockData", () => {
  it("inserts a realistic multi-scenario dataset", () => {
    const db = freshDb();
    seedMockData(db);

    expect(db.select().from(schema.tickets).all().length).toBeGreaterThanOrEqual(4);
    expect(db.select().from(schema.workers).all().length).toBeGreaterThanOrEqual(3);

    const ts = db.select().from(schema.tickets).all();
    expect(ts.some((t) => t.bmStatus === "completed")).toBe(true);
    expect(ts.some((t) => t.bmStatus === "abandoned" && t.attemptCount === t.maxAttempts)).toBe(true);

    const runs = db.select().from(schema.runs).all();
    expect(runs.some((r) => r.attemptNumber >= 2 && r.trigger === "ci_failure")).toBe(true);

    expect(db.select().from(schema.workers).all().some((w) => w.status === "dead")).toBe(true);
    expect(runs.some((r) => r.status === "timed_out")).toBe(true);
  });

  it("is idempotent: clears and reseeds without unique-constraint errors", () => {
    const db = freshDb();
    seedMockData(db);
    expect(() => seedMockData(db)).not.toThrow();
  });
});
