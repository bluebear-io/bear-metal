import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runCommand } from "../shared/command.js";
import type { Logger } from "../shared/index.js";

export interface RunWorkerEnvironmentBuilderInput {
  /** Inline bash script content. Mutually exclusive with path. */
  command?: string | null;
  /** Path to an executable script. Mutually exclusive with command. */
  path?: string | null;
  logger: Logger;
  /** Override the bash execution timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Operator-controlled startup hook. Prepares the Bear Metal process environment
 * (toolchains, package managers, OS libs) once, before scheduler/task worker start.
 *
 * Inherits process.env. Not scoped to AGENT_WORKDIR; not exposed to the coding agent.
 */
export async function runWorkerEnvironmentBuilder(input: RunWorkerEnvironmentBuilderInput): Promise<void> {
  const { command, path, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  if (command && path) {
    throw new Error(
      "WORKER_ENVIRONMENT_BUILDER_COMMAND and WORKER_ENVIRONMENT_BUILDER_PATH are mutually exclusive — set at most one",
    );
  }
  if (!command && !path) {
    return;
  }

  let tempDir: string | undefined;
  let scriptPath: string;
  if (command) {
    tempDir = await mkdtemp(resolve(tmpdir(), "bear-metal-worker-env-"));
    await chmod(tempDir, 0o700);
    scriptPath = resolve(tempDir, "worker-environment-builder.sh");
    const content = command.startsWith("#!")
      ? command.replace(/^(#!.*\n?)/, "$1set -euo pipefail\n")
      : `#!/usr/bin/env bash\nset -euo pipefail\n${command}`;
    await writeFile(scriptPath, content, { mode: 0o700 });
  } else {
    scriptPath = path!;
  }

  logger.info({ source: command ? "command" : "path" }, "worker environment builder: starting");
  try {
    const result = await runCommand("bash", [scriptPath], {
      cwd: process.cwd(),
      timeoutMs,
    });
    logger.info(
      { stdoutLen: result.stdout.length, stderrLen: result.stderr.length },
      "worker environment builder: succeeded",
    );
  } catch (err) {
    logger.error({ err }, "worker environment builder: failed");
    throw err;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
