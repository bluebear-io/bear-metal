import type { WorkerConfig } from "./types.js";

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    githubToken: requireEnv(env, "GITHUB_TOKEN"),
    githubOwner: requireEnv(env, "GITHUB_OWNER"),
    githubRepo: requireEnv(env, "GITHUB_REPO"),
    linearApiToken: requireEnv(env, "LINEAR_API_TOKEN"),
  };
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
