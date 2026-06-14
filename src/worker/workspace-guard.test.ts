import { describe, expect, it } from "vitest";
import { assertRepoRootInWorkspace, validateWorkspaceBashCommand } from "./workspace-guard.js";

describe("workspace guard", () => {
  it("rejects repo roots outside the cloned workspace", () => {
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/blueden", "/tmp/workspace/blueden/bear-metal")).not.toThrow();
    expect(() => assertRepoRootInWorkspace("/tmp/workspace/blueden", "/Users/aviv/projects/blueden-4/bear-metal")).toThrow(
      /outside workspace/,
    );
  });

  it("rejects bash commands that escape the workspace", () => {
    expect(() => validateWorkspaceBashCommand("git status", "/tmp/workspace/blueden")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("npx vitest run src/**/*.test.ts", "/tmp/workspace/blueden")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("git remote add origin https://github.com/bluebear-io/blueden", "/tmp/workspace/blueden")).not.toThrow();
    expect(() => validateWorkspaceBashCommand("cd /Users/aviv/projects/blueden-4/bear-metal", "/tmp/workspace/blueden")).toThrow(
      /outside workspace/,
    );
    expect(() => validateWorkspaceBashCommand("cd ..", "/tmp/workspace/blueden")).toThrow(/outside workspace/);
    expect(() => validateWorkspaceBashCommand("ls ~/projects", "/tmp/workspace/blueden")).toThrow(/outside workspace/);
  });

  it("blocks git push in all forms", () => {
    const root = "/tmp/workspace/blueden";
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
    const root = "/tmp/workspace/blueden";
    expect(() => validateWorkspaceBashCommand("gh pr create", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh issue list", root)).toThrow(/gh CLI is not allowed/);
    expect(() => validateWorkspaceBashCommand("gh auth status", root)).toThrow(/gh CLI is not allowed/);
    // similar-looking strings that are not the gh CLI remain allowed
    expect(() => validateWorkspaceBashCommand("echo 'gh is cool'", root)).not.toThrow();
    expect(() => validateWorkspaceBashCommand("touch /tmp/workspace/blueden/ghfile", root)).not.toThrow();
  });
});
