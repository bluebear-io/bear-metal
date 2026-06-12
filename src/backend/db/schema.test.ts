import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

describe("schema", () => {
  it("exports the full table set (six dashboard tables + ci_checks + review_threads + run_tool_calls)", () => {
    expect(Object.keys(schema).sort()).toEqual(
      ["ciChecks", "ciRuns", "events", "pullRequests", "reviewThreads", "runToolCalls", "runs", "tickets", "workers"].sort(),
    );
  });

  it("agrees with the generated migration: a tickets row round-trips through the Drizzle schema", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./src/backend/db/migrations" });

    db.insert(schema.tickets)
      .values({
        id: "ticket-1",
        identifier: "DEN-2271",
        title: "Design UI application",
        url: "https://linear.app/bluebear/issue/DEN-2271",
        branchName: "feature/den-2271-design-ui-application",
        linearStatusName: "In Progress",
        linearStatusType: "started",
        bmStatus: "discovered",
        maxAttempts: 3,
        createdAt: new Date("2026-06-09T00:00:00.000Z"),
        updatedAt: new Date("2026-06-09T00:00:00.000Z"),
      })
      .run();

    const rows = db.select().from(schema.tickets).all();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toBeDefined();
    expect(row!.identifier).toBe("DEN-2271");
    expect(row!.attemptCount).toBe(0);
    expect(row!.labelsJson).toBe("[]");

    sqlite.close();
  });
});
