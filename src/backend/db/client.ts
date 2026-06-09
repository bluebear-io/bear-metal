import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export interface ReadOnlyDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

/**
 * Opens the agent's SQLite file read-only. Fails fast (per repo policy): a missing
 * file is a configuration error, never silently created or substituted.
 */
export function openReadOnlyDb(path: string): ReadOnlyDb {
  if (!existsSync(path)) {
    throw new Error(`Bear Metal database file not found at "${path}"`);
  }
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
