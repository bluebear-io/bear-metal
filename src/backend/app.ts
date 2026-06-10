import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { Repository } from "./db/repository.js";
import type { Writer } from "./db/writer.js";
import { authStub } from "./middleware/auth.js";
import { createRouter } from "./routes/index.js";
import { createIngestRouter } from "./routes/ingest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// /app/dist/backend/../../ui-dist → /app/ui-dist (copied by Dockerfile)
const UI_DIST = join(__dirname, "../../ui-dist");

export interface AppOptions {
  /** Shared secret enabling the write (ingest) API. Empty/omitted → read-only server. */
  ingestToken?: string;
  /** Dialect-agnostic Writer used by the ingest router. Required iff `ingestToken` is set. */
  writer?: Writer;
}

/** Repository powers the read API; Writer (gated by ingestToken) powers the write API. */
export function createApp(repo: Repository, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(authStub);
  if (options.ingestToken) {
    if (!options.writer) {
      throw new Error("createApp: options.writer is required when ingestToken is set");
    }
    app.use("/api", createIngestRouter(options.writer, options.ingestToken));
  }
  app.use("/api", createRouter(repo));
  app.use(express.static(UI_DIST));
  // SPA fallback — all non-API routes serve index.html so React Router handles them
  app.get("*", (_req, res) => {
    res.sendFile(join(UI_DIST, "index.html"));
  });
  return app;
}
