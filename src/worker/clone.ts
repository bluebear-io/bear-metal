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
  signal?: AbortSignal;
}): Promise<CloneScriptResult> {
  input.signal?.throwIfAborted();
  const agentWorkdir = resolve(input.workspaceDir, "agent");
  await rm(agentWorkdir, { recursive: true, force: true });
  await mkdir(agentWorkdir, { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Workspace builder timed out")), input.timeoutMs ?? WORKSPACE_BUILD_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    await Promise.race([
      Promise.resolve(input.buildWorkspace({ workspacePath: agentWorkdir, signal })),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
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
    signal.throwIfAborted();
    netrcDir = await mkdtemp(resolve(tmpdir(), "bear-metal-git-"));
    await chmod(netrcDir, 0o700);
    await writeFile(resolve(netrcDir, ".netrc"), `machine github.com login x-access-token password ${input.githubToken}\n`, { mode: 0o600 });
    await writeFile(resolve(netrcDir, "askpass.sh"), [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      "  *Password*)",
      '    case "$0" in */*) netrc_path="${0%/*}/.netrc" ;; *) printf "Git credential helper path is invalid\\n" >&2; exit 1 ;; esac',
      '    if [ ! -r "$netrc_path" ]; then printf "Git credential file is unreadable\\n" >&2; exit 1; fi',
      '    while IFS= read -r line; do',
      '      case "$line" in',
      "        'machine github.com login x-access-token password '*)",
      '          printf "%s\\n" "${line#machine github.com login x-access-token password }"',
      "          exit 0 ;;",
      "      esac",
      '    done < "$netrc_path"',
      '    printf "Git credential entry is missing\\n" >&2; exit 1 ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o700 });
    return { agentWorkdir, workspaceDir: input.workspaceDir, stdout: "", stderr: "", netrcDir };
  } catch (error) {
    await rm(input.workspaceDir, { recursive: true, force: true });
    if (netrcDir) await rm(netrcDir, { recursive: true, force: true });
    throw error;
  }
}

export function workspaceForTicket(ticketId: string): string {
  const safeTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return resolve(workspaceBase(), safeTicketId);
}

export function workspaceForResearchTask(taskId: string): string {
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return resolve(workspaceBase(), "research", safeTaskId);
}

export function workspaceForCoordinatorGeneration(generationId: string): string {
  return resolve(workspaceForCoordinatorRoot(), generationId);
}

export function workspaceForCoordinatorRoot(): string {
  return resolve(workspaceBase(), "coordinator");
}

function workspaceBase(): string {
  const base = process.env.BEAR_METAL_WORKSPACE_DIR ?? resolve(homedir(), ".bear-metal", "workspace");
  return base;
}
