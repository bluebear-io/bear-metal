import path from "node:path";
import { PostgresClient } from "./postgres-client.js";
import { SqliteClient } from "./sqlite-client.js";
import type { DatabaseClient, DatabaseDriver } from "./types.js";

export interface CreateDatabaseClientOptions {
  /** Defaults to process.env. Override in tests. */
  env?: NodeJS.ProcessEnv;
  /** Used to resolve the default sqlite path. Defaults to cwd. */
  packageRoot?: string;
}

export interface ResolvedDatabaseConfig {
  driver: DatabaseDriver;
  /** Postgres connection string when driver === 'postgres'. */
  connectionString?: string;
  /** Sqlite file path when driver === 'sqlite'. */
  path?: string;
}

/**
 * Resolve database configuration from env vars.
 *
 * Precedence:
 *   1. DATABASE_URL set → postgres (must start with postgres:// or postgresql://)
 *   2. otherwise → sqlite at DATABASE_PATH, falling back to <packageRoot>/bear-metal.sqlite
 */
export function resolveDatabaseConfig(
  env: NodeJS.ProcessEnv,
  packageRoot: string,
): ResolvedDatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      throw new Error(
        `DATABASE_URL must start with postgres:// or postgresql://, got: ${url.slice(0, 16)}...`,
      );
    }
    return { driver: "postgres", connectionString: url };
  }
  const sqlitePath = env.DATABASE_PATH?.trim() || path.join(packageRoot, "bear-metal.sqlite");
  return { driver: "sqlite", path: sqlitePath };
}

/**
 * Create and initialize a DatabaseClient based on env vars.
 *
 * Caller owns the lifecycle and must call `close()` on shutdown.
 */
export async function createDatabaseClient(
  opts: CreateDatabaseClientOptions = {},
): Promise<DatabaseClient> {
  const env = opts.env ?? process.env;
  const packageRoot = opts.packageRoot ?? process.cwd();
  const config = resolveDatabaseConfig(env, packageRoot);

  const client: DatabaseClient =
    config.driver === "postgres"
      ? new PostgresClient({ connectionString: config.connectionString! })
      : new SqliteClient({ path: config.path! });

  await client.init();
  return client;
}
