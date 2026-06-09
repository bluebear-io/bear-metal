import "dotenv/config";

import { createLogger } from "../shared/logger.js";
import { loadBackendConfig } from "./config.js";
import { openReadOnlyDb } from "./db/client.js";
import { createApp } from "./app.js";

function main(): void {
  const config = loadBackendConfig();
  const logger = createLogger({ level: config.logLevel, name: "bear-metal-backend" });
  const { dbPath, port } = config;
  const { db, sqlite } = openReadOnlyDb(dbPath);
  const app = createApp(db);
  const server = app.listen(port, () => logger.info({ port, dbPath }, "bear-metal dashboard backend listening"));

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close(() => {
      sqlite.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
