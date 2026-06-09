import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runCommand } from "../shared/command.js";
import type { CloneScriptResult } from "./types.js";

export async function runCloneScript(input: {
  packageRoot: string;
  workspaceDir: string;
}): Promise<CloneScriptResult> {
  const scriptPath = resolve(input.packageRoot, "scripts", "clone-target-repos.sh");
  await ensureCloneTargetDoesNotExist(input.workspaceDir);
  const result = await runCommand("bash", [scriptPath], {
    cwd: input.workspaceDir,
    timeoutMs: 10 * 60 * 1000,
  });

  return {
    scriptPath,
    workspaceDir: input.workspaceDir,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function getPackageRoot(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..", "..");
}

export function workspaceForTicket(packageRoot: string, ticketId: string): string {
  const safeTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return resolve(packageRoot, "workspace", safeTicketId);
}

async function ensureCloneTargetDoesNotExist(workspaceDir: string): Promise<void> {
  const target = resolve(workspaceDir, "blueden");
  try {
    await access(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Clone target already exists: ${target}`);
}
