import { describe, expect, it } from "vitest";
import * as schemaSqlite from "./schema.js";
import * as schemaPg from "./schema-pg.js";

// Compile-time type equality helper. `Expect<Equal<A, B>>` is `true` iff A and B are structurally
// the same, failing at typecheck time otherwise.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/**
 * The pg and sqlite schemas must produce identical TypeScript types when consumed via
 * Drizzle's `$inferSelect`/`$inferInsert`. The rest of the codebase references a single
 * `Ticket`/`NewTicket`/etc. — if these checks fail, the writer/repository signatures will
 * silently diverge for one of the dialects.
 */

type SqliteSelect = {
  tickets: typeof schemaSqlite.tickets.$inferSelect;
  workers: typeof schemaSqlite.workers.$inferSelect;
  runs: typeof schemaSqlite.runs.$inferSelect;
  pullRequests: typeof schemaSqlite.pullRequests.$inferSelect;
  ciRuns: typeof schemaSqlite.ciRuns.$inferSelect;
  events: typeof schemaSqlite.events.$inferSelect;
};

type PgSelect = {
  tickets: typeof schemaPg.tickets.$inferSelect;
  workers: typeof schemaPg.workers.$inferSelect;
  runs: typeof schemaPg.runs.$inferSelect;
  pullRequests: typeof schemaPg.pullRequests.$inferSelect;
  ciRuns: typeof schemaPg.ciRuns.$inferSelect;
  events: typeof schemaPg.events.$inferSelect;
};

type SqliteInsert = {
  tickets: typeof schemaSqlite.tickets.$inferInsert;
  workers: typeof schemaSqlite.workers.$inferInsert;
  runs: typeof schemaSqlite.runs.$inferInsert;
  pullRequests: typeof schemaSqlite.pullRequests.$inferInsert;
  ciRuns: typeof schemaSqlite.ciRuns.$inferInsert;
  events: typeof schemaSqlite.events.$inferInsert;
};

type PgInsert = {
  tickets: typeof schemaPg.tickets.$inferInsert;
  workers: typeof schemaPg.workers.$inferInsert;
  runs: typeof schemaPg.runs.$inferInsert;
  pullRequests: typeof schemaPg.pullRequests.$inferInsert;
  ciRuns: typeof schemaPg.ciRuns.$inferInsert;
  events: typeof schemaPg.events.$inferInsert;
};

// Compile-time assertions — failing checks become TS errors at typecheck time.
type _AssertSelect = Expect<Equal<SqliteSelect, PgSelect>>;
type _AssertInsert = Expect<Equal<SqliteInsert, PgInsert>>;

describe("schema-pg parity", () => {
  it("declares the same set of table exports as schema (sqlite)", () => {
    const sqliteNames = Object.keys(schemaSqlite).filter((k) => !k.startsWith("_")).sort();
    const pgNames = Object.keys(schemaPg).filter((k) => !k.startsWith("_")).sort();
    expect(pgNames).toEqual(sqliteNames);
  });

  it("declares matching enum values for each enum column", () => {
    expect(schemaPg.tickets.bmStatus.enumValues).toEqual(schemaSqlite.tickets.bmStatus.enumValues);
    expect(schemaPg.workers.status.enumValues).toEqual(schemaSqlite.workers.status.enumValues);
    expect(schemaPg.runs.trigger.enumValues).toEqual(schemaSqlite.runs.trigger.enumValues);
    expect(schemaPg.runs.status.enumValues).toEqual(schemaSqlite.runs.status.enumValues);
    expect(schemaPg.runs.stopReason.enumValues).toEqual(schemaSqlite.runs.stopReason.enumValues);
    expect(schemaPg.pullRequests.state.enumValues).toEqual(schemaSqlite.pullRequests.state.enumValues);
    expect(schemaPg.ciRuns.status.enumValues).toEqual(schemaSqlite.ciRuns.status.enumValues);
    expect(schemaPg.events.source.enumValues).toEqual(schemaSqlite.events.source.enumValues);
    expect(schemaPg.events.type.enumValues).toEqual(schemaSqlite.events.type.enumValues);
  });
});
