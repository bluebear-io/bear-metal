import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { WORKSPACE_BUILD_TIMEOUT_MS, type TaskCustomization } from "../customization/types.js";
import type { CloneScriptResult } from "./types.js";

export async function runWorkspaceBuilder(input: {
  workspaceDir: string;
  githubToken: string;
  buildWorkspace: TaskCustomization["buildWorkspace"];
  timeoutMs?: number;
}): Promise<CloneScriptResult> {
  const agentWorkdir = resolve(input.workspaceDir, "agent");
  await rm(agentWorkdir, { recursive: true, force: true });
  await mkdir(agentWorkdir, { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Workspace builder timed out")), input.timeoutMs ?? WORKSPACE_BUILD_TIMEOUT_MS);
  try {
    await Promise.race([
      Promise.resolve(input.buildWorkspace({ workspacePath: agentWorkdir, signal: controller.signal })),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
    if ((await readdir(agentWorkdir)).length === 0) {
      throw new Error(`Workspace builder completed but workspacePath is empty: ${agentWorkdir}`);
    }
  } catch (error) {
    await rm(input.workspaceDir, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let netrcDir: string | undefined;
  try {
    netrcDir = await mkdtemp(resolve(tmpdir(), "bear-metal-git-"));
    await chmod(netrcDir, 0o700);
    await writeFile(resolve(netrcDir, ".netrc"), `machine github.com login x-access-token password ${input.githubToken}\n`, { mode: 0o600 });
    await writeFile(resolve(netrcDir, "askpass.sh"), '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) sed -n "s/^machine github.com login x-access-token password //p" "$(dirname "$0")/.netrc" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
    return { agentWorkdir, workspaceDir: input.workspaceDir, stdout: "", stderr: "", netrcDir };
  } catch (error) {
    await rm(input.workspaceDir, { recursive: true, force: true });
    if (netrcDir) await rm(netrcDir, { recursive: true, force: true });
    throw error;
  }
}

export function workspaceForTicket(ticketId: string): string {
  const safeTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = process.env.BEAR_METAL_WORKSPACE_DIR ?? resolve(homedir(), ".bear-metal", "workspace");
  return resolve(base, safeTicketId);
}
