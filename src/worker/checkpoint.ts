import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runCommand } from "../shared/command.js";
import { redactSensitiveText } from "../agent-tools/transport.js";

export interface RepositoryCheckpoint {
  path: string;
  remote: string | null;
  branch: string | null;
  commit: string | null;
  pushed: boolean;
  error: string | null;
}

export interface Checkpoint {
  workspaceRoot: string;
  repositories: RepositoryCheckpoint[];
  error: string | null;
}

export function checkpointPushed(checkpoint: Checkpoint): boolean {
  return checkpoint.error === null && checkpoint.repositories.length > 0 && checkpoint.repositories.every((repo) => repo.pushed);
}

const excluded = new Set([".git", "node_modules", ".venv", "venv"]);

async function repositoriesIn(root: string): Promise<string[]> {
  const repositories: string[] = [];
  async function visit(path: string) {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git")) repositories.push(path);
    for (const entry of entries) {
      if (entry.isDirectory() && !excluded.has(entry.name)) await visit(resolve(path, entry.name));
    }
  }
  await visit(root);
  // Commit children before parents so submodule pointers include their saved commits.
  return repositories.reverse();
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  return runCommand("git", args, { cwd, env: { ...process.env, ...env }, timeoutMs: 300_000, signal });
}

export async function saveCheckpoint(input: {
  workspaceRoot: string;
  branch: string;
  ticketId: string;
  gitEnv: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertLease?: () => Promise<void>;
}): Promise<Checkpoint> {
  // assertLease checks the abort signal itself.
  const checkLease = async () => input.assertLease ? input.assertLease() : input.signal?.throwIfAborted();
  await checkLease();
  const checkpoint: Checkpoint = { workspaceRoot: input.workspaceRoot, repositories: [], error: null };
  try {
    const roots = await repositoriesIn(input.workspaceRoot);
    if (roots.length === 0) throw new Error("No Git repositories found in task workspace");
    for (const root of roots) {
      const saved: RepositoryCheckpoint = { path: relative(input.workspaceRoot, root) || ".", remote: null, branch: null, commit: null, pushed: false, error: null };
      checkpoint.repositories.push(saved);
      const run = (args: string[]) => git(root, args, input.gitEnv, input.signal);
      try {
        const remote = (await run(["remote", "get-url", "origin"])).stdout.trim();
        const url = URL.canParse(remote) ? new URL(remote) : null;
        // Restore compares origins exactly, so a credentialed origin is refused rather than redacted.
        if (url?.password || url?.search || (url?.protocol.match(/^https?:$/) && url.username)) {
          throw new Error("Origin URL contains credentials; refusing to persist it");
        }
        saved.remote = remote;
        const current = (await run(["branch", "--show-current"])).stdout.trim();
        if (!current) throw new Error("Cannot checkpoint a detached HEAD");
        saved.branch = current === "main" || current === "master" ? input.branch : current;
        if (!saved.branch || saved.branch === "main" || saved.branch === "master") throw new Error("Checkpoint requires a task branch");
        await run(["check-ref-format", "--branch", saved.branch]);
        if (current !== saved.branch) await run(["switch", "-c", saved.branch]);
        if ((await run(["status", "--porcelain"])).stdout.trim()) {
          await run(["add", "-A"]);
          // Git hooks and signing remain enabled; failed safeguards retain the workspace.
          await run(["commit", "-m", `chore(checkpoint): [${input.ticketId}] save unfinished work at token limit`]);
        }
        saved.commit = (await run(["rev-parse", "HEAD"])).stdout.trim();
        await checkLease();
        // A clean branch may still have unpushed commits, or already be fully pushed.
        await run(["push", "-u", "origin", `HEAD:refs/heads/${saved.branch}`]);
        saved.pushed = true;
      } catch (error) {
        await checkLease();
        saved.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    await checkLease();
    checkpoint.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
  }
  return checkpoint;
}

export async function restoreCheckpoint(workspaceRoot: string, checkpoint: Checkpoint, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (!checkpoint.repositories.length) throw new Error(`Checkpoint has no repositories; recover retained workspace ${checkpoint.workspaceRoot}`);
  const root = await realpath(workspaceRoot);
  for (const repo of [...checkpoint.repositories].reverse()) {
    signal?.throwIfAborted();
    const path = await realpath(resolve(root, repo.path));
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Checkpoint repository escapes workspace");
    const run = (args: string[]) => git(path, args, env, signal);
    const remote = (await run(["remote", "get-url", "origin"])).stdout.trim();
    if (remote !== repo.remote) throw new Error(`Checkpoint origin mismatch for ${repo.path}`);
    if (!repo.branch || !repo.commit || !/^[0-9a-f]{40,64}$/.test(repo.commit)) throw new Error(`Invalid checkpoint reference for ${repo.path}`);
    await run(["check-ref-format", "--branch", repo.branch]);
    if ((await run(["status", "--porcelain"])).stdout.trim()) throw new Error(`Cannot restore checkpoint over changes in ${repo.path}`);
    await run(["fetch", "origin", `refs/heads/${repo.branch}`]);
    await run(["merge-base", "--is-ancestor", repo.commit, "FETCH_HEAD"]);
    const local = (await run(["for-each-ref", "--format=%(objectname)", `refs/heads/${repo.branch}`])).stdout.trim();
    if (local) await run(["merge-base", "--is-ancestor", local, "FETCH_HEAD"]);
    await run(["switch", "-C", repo.branch, "FETCH_HEAD"]);
  }
}

export function checkpointMessage(checkpoint: Checkpoint): string {
  const lines = checkpoint.repositories.map((repo) => {
    const outcome = repo.pushed ? "pushed" : `NOT pushed: ${repo.error ?? "not attempted"}`;
    return `${repo.path}: branch ${repo.branch ?? "unknown"}, commit ${repo.commit ?? "not committed"}, ${outcome}`;
  });
  if (checkpoint.error) lines.push(checkpoint.error);
  if (!checkpointPushed(checkpoint)) lines.push(`Workspace retained at ${checkpoint.workspaceRoot}. Recover it before re-delegating.`);
  return lines.join("\n");
}
