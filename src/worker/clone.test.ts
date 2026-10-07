import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkspaceBuilder } from "./clone.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("runWorkspaceBuilder", () => {
  it("cancels a real builder subprocess when the worker lease is lost", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-"));
    paths.push(workspaceDir);
    const controller = new AbortController();
    let childPid = 0;
    const build = runWorkspaceBuilder({
      workspaceDir, githubToken: "token", signal: controller.signal,
      buildWorkspace: async ({ signal }) => {
        const run = promisify(execFile)(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal });
        childPid = run.child.pid!;
        await run;
      },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(childPid).toBeGreaterThan(0));
    controller.abort(new Error("Task lease lost"));
    expect(await build).toMatchObject({ message: "Task lease lost" });
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
  });
  it("creates the target, passes an abort signal, and accepts a non-empty workspace", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-"));
    paths.push(workspaceDir);
    let receivedPath = "";
    const result = await runWorkspaceBuilder({ workspaceDir, githubToken: "token", buildWorkspace: async ({ workspacePath, signal }) => { receivedPath = workspacePath; expect(signal.aborted).toBe(false); await writeFile(join(workspacePath, "README.md"), "ready"); } });
    paths.push(result.netrcDir);
    expect(receivedPath).toBe(result.agentWorkdir);
    expect(await readdir(result.agentWorkdir)).toEqual(["README.md"]);
  });
  it("supplies Git credentials without using HOME and reads refreshed tokens", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-")); paths.push(workspaceDir);
    const result = await runWorkspaceBuilder({ workspaceDir, githubToken: "initial-token", buildWorkspace: async ({ workspacePath }) => { await writeFile(join(workspacePath, "README.md"), "ready"); } });
    paths.push(result.netrcDir);
    const fill = () => execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, GIT_ASKPASS: join(result.netrcDir, "askpass.sh"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(fill()).toContain("password=initial-token");
    await writeFile(join(result.netrcDir, ".netrc"), "machine github.com login x-access-token password refreshed-token\n", { mode: 0o600 });
    expect(fill()).toContain("password=refreshed-token");
  });
  it("reads the token without external shell utilities and reports missing credentials", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-")); paths.push(workspaceDir);
    const result = await runWorkspaceBuilder({ workspaceDir, githubToken: "initial-token", buildWorkspace: async ({ workspacePath }) => { await writeFile(join(workspacePath, "README.md"), "ready"); } });
    paths.push(result.netrcDir);
    const helper = join(result.netrcDir, "askpass.sh");
    expect(execFileSync(helper, ["Password for https://github.com"], { encoding: "utf8", env: { PATH: "/nonexistent" } })).toBe("initial-token\n");
    await rm(join(result.netrcDir, ".netrc"));
    expect(() => execFileSync(helper, ["Password for https://github.com"], { encoding: "utf8", env: { PATH: "/nonexistent" }, stdio: "pipe" })).toThrow("Git credential file is unreadable");
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
