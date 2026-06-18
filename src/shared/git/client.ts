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
