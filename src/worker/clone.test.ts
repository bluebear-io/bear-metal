import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.hoisted(() => ({
  runCommand: vi.fn(async () => ({ stdout: "cloned", stderr: "" })),
}));

vi.mock("../shared/command.js", () => ({
  runCommand: commandMock.runCommand,
}));

describe("runCloneScript", () => {
  beforeEach(() => {
    commandMock.runCommand.mockClear();
  });

  it("removes an existing ticket clone before running the clone script", async () => {
    const { runCloneScript } = await import("./clone.js");
    const root = await mkdtempRoot();
    const workspaceDir = join(root, "workspace", "DEN-1");
    const cloneTarget = join(workspaceDir, "blueden");
    await mkdir(cloneTarget, { recursive: true });
    await writeFile(join(cloneTarget, "stale.txt"), "stale", "utf8");

    try {
      const result = await runCloneScript({ packageRoot: root, workspaceDir, githubToken: "test-token" });

      expect(result).toEqual({
        scriptPath: join(root, "scripts", "clone-target-repos.sh"),
        workspaceDir,
        stdout: "cloned",
        stderr: "",
      });
      await expect(access(cloneTarget)).rejects.toMatchObject({ code: "ENOENT" });
      expect(commandMock.runCommand).toHaveBeenCalledWith("bash", [join(root, "scripts", "clone-target-repos.sh")], {
        cwd: workspaceDir,
        timeoutMs: 10 * 60 * 1000,
        env: expect.objectContaining({ GH_TOKEN: "test-token" }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkdtempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bear-metal-clone-"));
}
