import "dotenv/config";

import { createLogger } from "../shared/logger.js";
import { loadBackendConfig } from "./config.js";
import { openReadOnlyDb } from "./db/client.js";
import { createApp } from "./app.js";

function main(): void {
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? "info", name: "bear-metal-backend" });
  const { dbPath, port } = loadBackendConfig();
  const { db } = openReadOnlyDb(dbPath);
  const app = createApp(db);
  app.listen(port, () => logger.info({ port, dbPath }, "bear-metal dashboard backend listening"));
}

main();
