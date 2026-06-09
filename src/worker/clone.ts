import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runCommand } from "../shared/command.js";
import type { CloneScriptResult } from "./types.js";

export async function runCloneScript(input: {
  packageRoot: string;
  workspaceDir: string;
  githubToken: string;
}): Promise<CloneScriptResult> {
  const scriptPath = resolve(input.packageRoot, "scripts", "clone-target-repos.sh");
  await rm(resolve(input.workspaceDir, "blueden"), { recursive: true, force: true });
  const result = await runCommand("bash", [scriptPath], {
    cwd: input.workspaceDir,
    timeoutMs: 10 * 60 * 1000,
    env: { ...process.env, GH_TOKEN: input.githubToken },
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

export function workspaceForTicket(_packageRoot: string, ticketId: string): string {
  const safeTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = process.env.BEAR_METAL_WORKSPACE_DIR ?? resolve(homedir(), ".bear-metal", "workspace");
  return resolve(base, safeTicketId);
}
