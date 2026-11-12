import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../shared/command.js";
import { parseGitHubRemote } from "../shared/git/client.js";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
// Repository hooks and config are agent-writable, so git commands Bear Metal runs ignore hooks, and the
// authenticated push runs from a bare repository Bear Metal creates, never from the agent's checkout.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return runCommand("git", [...NO_HOOKS, ...args], {
    cwd, timeoutMs: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
}

/** Checks the built workspace is the requested repository at the base SHA, and starts the scratch branch there. */
export async function prepareScratchCheckout(repoRoot: string, spec: { repository: string; baseSha: string; scratchBranch: string | null }): Promise<void> {
  const head = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  if (head !== spec.baseSha) throw new Error(`Workspace is at ${head}, not the requested base ${spec.baseSha}`);
  const remote = parseGitHubRemote((await git(["remote", "get-url", "origin"], repoRoot)).stdout.trim());
  if (`${remote.owner}/${remote.repo}`.toLowerCase() !== spec.repository.toLowerCase()) {
    throw new Error(`Workspace is a clone of ${remote.owner}/${remote.repo}, not ${spec.repository}`);
  }
  if (spec.scratchBranch) {
    await git(["check-ref-format", "--branch", spec.scratchBranch], repoRoot);
    await git(["switch", "-c", spec.scratchBranch], repoRoot);
  }
}

/**
 * Commits any pending changes, then pushes the checkout's HEAD to `branch` on GitHub. HEAD must descend
 * from `baseSha`. The token reaches only the git process that pushes from a fresh bare repository.
 */
export async function pushScratch(input: {
  repoRoot: string;
  repository: string;
  baseSha: string;
  branch: string;
  message: string;
  token: string;
  remoteUrl?: string;
}): Promise<{ sha: string; commits: string[] }> {
  if ((await git(["status", "--porcelain"], input.repoRoot)).stdout.trim()) {
    await git(["add", "-A"], input.repoRoot);
    await git(["commit", "--no-verify", "-m", input.message], input.repoRoot);
  }
  const sha = (await git(["rev-parse", "HEAD"], input.repoRoot)).stdout.trim();
  if (sha === input.baseSha) throw new Error("Nothing to push: there are no changes or commits since the base SHA");
  await git(["merge-base", "--is-ancestor", input.baseSha, sha], input.repoRoot).catch(() => {
    throw new Error(`HEAD ${sha} does not descend from the base SHA ${input.baseSha}`);
  });
  const commits = (await git(["rev-list", "--reverse", `${input.baseSha}..${sha}`], input.repoRoot)).stdout.split("\n").filter(Boolean);
  const staging = await mkdtemp(join(tmpdir(), "bear-metal-scratch-"));
  try {
    await chmod(staging, 0o700);
    const bare = join(staging, "repo.git");
    await runCommand("git", ["init", "--bare", "--quiet", bare], { cwd: staging, timeoutMs: GIT_TIMEOUT_MS });
    await git(["push", "--quiet", "--no-verify", bare, `${sha}:refs/heads/scratch`], input.repoRoot);
    const askpass = join(staging, "askpass.sh");
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$BEAR_METAL_PUSH_TOKEN" ;; esac\n', { mode: 0o700 });
    const remoteUrl = input.remoteUrl ?? `https://github.com/${input.repository}.git`;
    await runCommand("git", ["--git-dir", bare, ...NO_HOOKS, "push", "--quiet", "--no-verify", remoteUrl, `refs/heads/scratch:refs/heads/${input.branch}`], {
      cwd: staging, timeoutMs: GIT_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH, HOME: staging, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, BEAR_METAL_PUSH_TOKEN: input.token,
      },
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { sha, commits };
}

/** The changes since the base SHA, including uncommitted ones, as a patch. */
export async function diffSinceBase(repoRoot: string, baseSha: string): Promise<string> {
  await git(["add", "-A", "--intent-to-add"], repoRoot);
  return (await git(["diff", "--binary", baseSha], repoRoot)).stdout;
}
