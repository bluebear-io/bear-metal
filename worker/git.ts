import { basename } from "node:path";
import type { PullRequestRef } from "./types.js";
import { runCommand } from "./shell.js";

export type RemoteRef = {
  org: string;
  repo: string;
};

export async function commitAndPush(repoRoot: string, commitMessage: string): Promise<void> {
  const branch = (await git(["branch", "--show-current"], repoRoot)).stdout.trim();
  if (!branch) {
    throw new Error(`Could not determine current git branch in ${repoRoot}`);
  }
  if (branch === "main" || branch === "master") {
    throw new Error(`Refusing to commit task changes directly on ${branch}; create or check out a task branch first`);
  }

  const status = (await git(["status", "--porcelain"], repoRoot)).stdout.trim();
  if (!status) {
    throw new Error(`wrote_code called but ${repoRoot} has no git changes`);
  }

  await git(["add", "-A"], repoRoot);
  await git(["commit", "-m", commitMessage], repoRoot);
  await git(["push", "-u", "origin", "HEAD"], repoRoot);
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return (await git(["branch", "--show-current"], repoRoot)).stdout.trim();
}

export async function getRemoteRef(repoRoot: string): Promise<RemoteRef> {
  const remoteUrl = (await git(["remote", "get-url", "origin"], repoRoot)).stdout.trim();
  return parseGitHubRemote(remoteUrl);
}

export function parseGitHubRemote(remoteUrl: string): RemoteRef {
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch) {
    return { org: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (httpsMatch) {
    return { org: httpsMatch[1], repo: httpsMatch[2] };
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

export function normalizePullRequestRef(ref: PullRequestRef): PullRequestRef {
  return {
    org: ref.org,
    repo: basename(ref.repo, ".git"),
    number: ref.number,
  };
}

function git(args: string[], cwd: string) {
  return runCommand("git", args, { cwd, timeoutMs: 5 * 60 * 1000 });
}
