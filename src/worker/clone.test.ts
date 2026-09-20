import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkspaceBuilder } from "./clone.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("runWorkspaceBuilder", () => {
  it("creates the target, passes an abort signal, and accepts a non-empty workspace", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-"));
    paths.push(workspaceDir);
    let receivedPath = "";
    const result = await runWorkspaceBuilder({ workspaceDir, githubToken: "token", buildWorkspace: async ({ workspacePath, signal }) => { receivedPath = workspacePath; expect(signal.aborted).toBe(false); await writeFile(join(workspacePath, "README.md"), "ready"); } });
    paths.push(result.netrcDir);
    expect(receivedPath).toBe(result.agentWorkdir);
    expect(await readdir(result.agentWorkdir)).toEqual(["README.md"]);
  });
  it("rejects an empty workspace", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-")); paths.push(workspaceDir);
    await expect(runWorkspaceBuilder({ workspaceDir, githubToken: "token", buildWorkspace: async () => {} })).rejects.toThrow("workspacePath is empty");
  });
  it("aborts a timed-out builder", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-")); paths.push(workspaceDir);
    await expect(runWorkspaceBuilder({ workspaceDir, githubToken: "token", timeoutMs: 5, buildWorkspace: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) })).rejects.toThrow("timed out");
  });
});
