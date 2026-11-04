import { runCommand } from "../command.js";

export type RemoteRef = {
  owner: string;
  repo: string;
};

export async function push(repoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const branch = (await git(["branch", "--show-current"], repoRoot, env)).stdout.trim();
  if (!branch) {
    throw new Error(`Could not determine current git branch in ${repoRoot}`);
  }
  if (branch === "main" || branch === "master") {
    throw new Error(`Refusing to push task changes directly on ${branch}; create or check out a task branch first`);
  }

  try {
    const unpushed = (await git(["log", "@{u}..HEAD", "--oneline"], repoRoot, env)).stdout.trim();
    if (!unpushed) {
      throw new Error(`push_for_review called but ${repoRoot} has no unpushed commits`);
    }
  } catch (err) {
    // If the error is about a missing upstream, allow the push (first push on this branch).
    if (!(err instanceof Error && err.message.includes("no upstream"))) {
      throw err;
    }
  }

  await git(["push", "-u", "origin", "HEAD"], repoRoot, env);
}

/** Switches to `branch` (creating it when missing), stages every change and commits it. Returns the commit SHA. */
export async function commitAll(repoRoot: string, branch: string, message: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (branch === "main" || branch === "master") {
    throw new Error(`Refusing to commit task changes directly on ${branch}; name a task branch`);
  }
  await git(["check-ref-format", "--branch", branch], repoRoot, env);
  const current = (await git(["branch", "--show-current"], repoRoot, env)).stdout.trim();
  if (current !== branch) {
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot, env).then(() => true, () => false);
    await git(exists ? ["switch", branch] : ["switch", "-c", branch], repoRoot, env);
  }
  await git(["add", "-A"], repoRoot, env);
  const staged = (await git(["diff", "--cached", "--name-only"], repoRoot, env)).stdout.trim();
  if (!staged) throw new Error(`commit_changes called but ${repoRoot} has no changes to commit`);
  await git(["commit", "-m", message], repoRoot, env);
  return (await git(["rev-parse", "HEAD"], repoRoot, env)).stdout.trim();
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
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  const httpsMatch = /^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remoteUrl);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return runCommand("git", args, { cwd, timeoutMs: 5 * 60 * 1000, env: env ? { ...process.env, ...env } : undefined });
}
