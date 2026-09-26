import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertRepoRootInWorkspace, createWorkspaceGuardedTools, validateWorkspaceBashCommand } from "./workspace-guard.js";

describe("workspace guard", () => {
  it("keeps language caches outside the disposable workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "bear-metal-home-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "bear-metal-workspace-test-"));
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "id_rsa"), "private-key");
    vi.stubEnv("HOME", home);
    try {
      const bash = createWorkspaceGuardedTools(workspace).find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();
      await (bash!.execute as (id: string, params: { command: string }) => Promise<unknown>)("cache", { command: 'mkdir -p "$HOME/go/pkg/mod" "$HOME/.cache/pip" && printf go > "$HOME/go/pkg/mod/marker" && printf python > "$HOME/.cache/pip/marker"' });
      const probe = await (bash!.execute as unknown as (id: string, params: { command: string }) => Promise<{ content: Array<{ text: string }> }>) ("probe", { command: 'test ! -e "$HOME/.ssh/id_rsa" && printf isolated' });
      expect(probe.content[0]?.text).toContain("isolated");
      await rm(workspace, { recursive: true, force: true });
      expect(await readFile(join(home, ".bear-metal/cache-home/go/pkg/mod/marker"), "utf8")).toBe("go");
      expect(await readFile(join(home, ".bear-metal/cache-home/.cache/pip/marker"), "utf8")).toBe("python");
    } finally {
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
  it("recovers on a later shell command after cache home becomes creatable", async () => {
    const home = await mkdtemp(join(tmpdir(), "bear-metal-home-recovery-test-"));
    const workspace = await mkdtemp(join(tmpdir(), "bear-metal-workspace-recovery-test-"));
    const blockedParent = join(home, ".bear-metal");
    await writeFile(blockedParent, "blocked");
    vi.stubEnv("HOME", home);
    try {
      const bash = createWorkspaceGuardedTools(workspace).find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();
      const execute = bash!.execute as unknown as (id: string, params: { command: string }) => Promise<{ content: Array<{ text: string }> }>;
      await expect(execute("blocked", { command: "printf ready" })).rejects.toThrow(/ENOTDIR|EEXIST/);
      await rm(blockedParent);
      const result = await execute("recovered", { command: "printf ready" });
      expect(result.content[0]?.text).toContain("ready");
    } finally {
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
  it("rejects repo roots outside the cloned workspace", () => {
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/myrepo", "/tmp/workspace/myrepo/bear-metal")).not.toThrow();
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/myrepo", "/Users/other/projects/bear-metal")).toThrow(
      /outside workspace/,
    );
  });

  it("rejects bash commands that escape the workspace", () => {
    expect(() => validateWorkspaceBashCommand("git status", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("npx vitest run src/**/*.test.ts", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git remote add origin https://github.com/your-org/myrepo", "/tmp/workspace/myrepo")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("cd /Users/other/projects/bear-metal", "/tmp/workspace/myrepo")).toThrow(
      /outside workspace/,
    );
    expect(() => validateWorkspaceBashCommand("cd ..", "/tmp/workspace/myrepo")).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("ls ~/projects", "/tmp/workspace/myrepo")).toThrow(/outside workspace/);
  });

  it("blocks git push in all forms", () => {
    const root = "/tmp/workspace/myrepo";
    expect(() => validateWorkspaceBashCommand("git push", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push -u origin HEAD", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push --force-with-lease", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push origin --delete my-branch", root)).toThrow(/git push is not allowed/);
    expect(() => validateWorkspaceBashCommand("git push --tags", root)).toThrow(/git push is not allowed/);
    // git operations that are not push remain allowed
    expect(() => validateWorkspaceBashCommand("git status", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git commit -m 'fix'", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git merge origin/main", root)).not.toThrow();
  });

  it("blocks gh CLI in all forms", () => {
    const root = "/tmp/workspace/myrepo";
    expect(() => validateWorkspaceBashCommand("gh pr create", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh issue list", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh auth status", root)).toThrow(/gh CLI is not allowed/);
    // similar-looking strings that are not the gh CLI remain allowed
    expect(() => validateWorkspaceBashCommand("echo 'gh is cool'", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("touch /tmp/workspace/myrepo/ghfile", root)).not.toThrow();
  });
});
