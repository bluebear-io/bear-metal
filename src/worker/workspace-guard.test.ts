import { describe, expect, it } from "vitest";
import { assertRepoRootInWorkspace, validateWorkspaceBashCommand } from "./workspace-guard.js";

describe("workspace guard", () => {
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
