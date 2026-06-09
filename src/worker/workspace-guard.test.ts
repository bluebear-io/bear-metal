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
});
