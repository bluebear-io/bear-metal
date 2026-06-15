import { homedir, tmpdir } from "node:os";
import { rm, mkdir, mkdtemp, chmod, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../shared/command.js";
import type { Ticket } from "../shared/integrations/linear/types.js";
import type { CloneScriptResult } from "./types.js";

export interface RunWorkspaceBuilderInput {
  workspaceDir: string;
  githubToken: string;
  ticket: Ticket;
  /** Inline bash script content. Mutually exclusive with builderPath. */
  builderCommand?: string;
  /** Path to an executable workspace builder script. Mutually exclusive with builderCommand. */
  builderPath?: string;
}

export async function runWorkspaceBuilder(input: RunWorkspaceBuilderInput): Promise<CloneScriptResult> {
  const { workspaceDir, githubToken, ticket, builderCommand, builderPath } = input;

  if (!builderCommand && !builderPath) {
    throw new Error("Either WORKSPACE_BUILDER_COMMAND or WORKSPACE_BUILDER_PATH must be set");
  }
  if (builderCommand && builderPath) {
    throw new Error("WORKSPACE_BUILDER_COMMAND and WORKSPACE_BUILDER_PATH are mutually exclusive");
  }

  const agentWorkdir = resolve(workspaceDir, "agent");

  // Clean slate — remove any leftover agent workdir from a prior run before rebuilding.
  await rm(agentWorkdir, { recursive: true, force: true });
  await mkdir(agentWorkdir, { recursive: true });

  // Write .netrc to a private temp dir so the token is never visible in ps aux.
  // HOME is overridden to that dir for the duration of the script so sub-clones inherit the same credentials.
  // SSH URLs (git@github.com:...) are rewritten to HTTPS via GIT_CONFIG_* so the container doesn't need an SSH client.
  // The netrcDir is NOT deleted here — it is returned and must be cleaned up by the caller after the full dispatch
  // (including pi's git push) completes.
  const netrcDir = await mkdtemp(resolve(tmpdir(), "bear-metal-clone-"));
  await chmod(netrcDir, 0o700);

  let scriptPath: string | undefined;

  try {
    const netrcPath = resolve(netrcDir, ".netrc");
    await writeFile(netrcPath, `machine github.com login x-access-token password ${githubToken}\n`, {
      mode: 0o600,
    });

    if (builderCommand) {
      const content = builderCommand.startsWith("#!") ? builderCommand : `#!/usr/bin/env bash\nset -euo pipefail\n${builderCommand}`;
      scriptPath = resolve(netrcDir, "workspace-builder.sh");
      await writeFile(scriptPath, content, { mode: 0o700 });
    } else {
      scriptPath = builderPath!;
    }

    const result = await runCommand("bash", [scriptPath], {
      cwd: workspaceDir,
      timeoutMs: 10 * 60 * 1000,
      env: {
        ...process.env,
        AGENT_WORKDIR: agentWorkdir,
        TICKET_ID: ticket.identifier,
        TICKET_TITLE: ticket.title,
        TICKET_URL: ticket.url,
        TICKET_TEAM: ticket.teamKey,
        TICKET_TAGS: ticket.labels.join(","),
        TICKET_DESCRIPTION: ticket.description ?? "",
        HOME: netrcDir,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
        GIT_CONFIG_VALUE_0: "git@github.com:",
      },
    });

    const entries = await readdir(agentWorkdir).catch(() => []);
    if (entries.length === 0) {
      throw new Error(
        `Workspace builder exited 0 but AGENT_WORKDIR is empty (${agentWorkdir}). ` +
        `Make sure your script clones into "$AGENT_WORKDIR".`,
      );
    }

    return {
      agentWorkdir,
      workspaceDir,
      stdout: result.stdout,
      stderr: result.stderr,
      netrcDir,
    };
  } catch (err) {
    await rm(netrcDir, { recursive: true, force: true });
    throw err;
  }
}

export function workspaceForTicket(ticketId: string): string {
  const safeTicketId = ticketId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = process.env.BEAR_METAL_WORKSPACE_DIR ?? resolve(homedir(), ".bear-metal", "workspace");
  return resolve(base, safeTicketId);
}
