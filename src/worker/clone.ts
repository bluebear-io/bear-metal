import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { rm, mkdir, writeFile } from "node:fs/promises";
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

  // Write .netrc to a private temp dir so the token is never visible in ps aux.
  // HOME is overridden to that dir for the duration of the script so sub-clones
  // (inside clone-repos.sh) inherit the same credentials.
  // SSH URLs (git@github.com:...) are rewritten to HTTPS via GIT_CONFIG_* so the
  // container doesn't need an SSH client.
  // The netrcDir is NOT deleted here — it is returned and must be cleaned up by the
  // caller after the full dispatch (including pi's git push) completes.
  const netrcDir = resolve(tmpdir(), `bear-metal-clone-${Date.now()}`);
  await mkdir(netrcDir, { mode: 0o700 });
  const netrcPath = resolve(netrcDir, ".netrc");
  await writeFile(netrcPath, `machine github.com login x-access-token password ${input.githubToken}\n`, {
    mode: 0o600,
  });

  const result = await runCommand("bash", [scriptPath], {
    cwd: input.workspaceDir,
    timeoutMs: 10 * 60 * 1000,
    env: {
      ...process.env,
      HOME: netrcDir,
      // Rewrite SSH URLs to HTTPS — no SSH client needed in the container
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_0: "git@github.com:",
    },
  });

  return {
    scriptPath,
    workspaceDir: input.workspaceDir,
    stdout: result.stdout,
    stderr: result.stderr,
    netrcDir,
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
