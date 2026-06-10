import "dotenv/config";

import { createLogger } from "../shared/index.js";
import { loadBackendConfig } from "./config.js";
import { openWritableDbFromUrl } from "./db/client.js";
import { createWriter } from "./db/writer.js";
import { createRepository } from "./db/repository.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadBackendConfig();
  const logger = createLogger({ level: config.logLevel, name: "bear-metal-backend" });
  const { databaseUrl, dialect, port } = config;
  const handle = await openWritableDbFromUrl(databaseUrl);
  const writer = createWriter(handle);
  const repo = createRepository(handle);
  const app = createApp(repo, { ingestToken: config.ingestToken, writer });
  // Never log the full databaseUrl — postgres:// URLs carry the password in clear text.
  const server = app.listen(port, () => logger.info({ port, dialect }, "bear-metal dashboard backend listening"));

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    // `server.close()`'s callback is invoked synchronously and its return value is ignored.
    // If we ran `await handle.close()` inside the callback, `process.exit` could fire before the
    // PG pool's drain completed. Sequence the two awaits manually instead.
    server.close(() => {
      handle
        .close()
        .catch((err) => logger.error({ err }, "error closing DB handle"))
        .finally(() => process.exit(0));
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
