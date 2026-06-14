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

const ticket = {
  id: "abc",
  identifier: "DEN-1",
  title: "Test ticket",
  description: "A test",
  url: "https://linear.app/test/issue/DEN-1",
  branchName: "feature/den-1-test",
  status: { name: "In Progress", type: "started" },
  priority: 0,
  labels: ["repo:blueden", "priority:high"],
  teamKey: "DEN",
  assignee: null,
  delegate: null,
};

describe("runWorkspaceBuilder", () => {
  beforeEach(() => {
    commandMock.runCommand.mockClear();
  });

  it("removes an existing agent workdir before running the builder", async () => {
    const { runWorkspaceBuilder } = await import("./clone.js");
    const root = await mkdtempRoot();
    const workspaceDir = join(root, "workspace", "DEN-1");
    const agentWorkdir = join(workspaceDir, "agent");
    await mkdir(agentWorkdir, { recursive: true });
    await writeFile(join(agentWorkdir, "stale.txt"), "stale", "utf8");

    try {
      const result = await runWorkspaceBuilder({
        workspaceDir,
        githubToken: "test-token",
        ticket,
        builderCommand: "git clone https://github.com/org/repo \"$AGENT_WORKDIR\"",
      });

      expect(result.agentWorkdir).toBe(agentWorkdir);
      expect(result.workspaceDir).toBe(workspaceDir);
      expect(result.stdout).toBe("cloned");
      expect(result.stderr).toBe("");
      expect(result.netrcDir).toEqual(expect.any(String));

      // stale.txt removed before the builder ran
      await expect(access(join(agentWorkdir, "stale.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes ticket context env vars to the builder", async () => {
    const { runWorkspaceBuilder } = await import("./clone.js");
    const root = await mkdtempRoot();
    const workspaceDir = join(root, "workspace", "DEN-1");

    try {
      await runWorkspaceBuilder({ workspaceDir, githubToken: "tok", ticket, builderCommand: "echo hi" });

      expect(commandMock.runCommand).toHaveBeenCalledWith(
        "bash",
        [expect.any(String)],
        expect.objectContaining({
          env: expect.objectContaining({
            TICKET_ID: "DEN-1",
            TICKET_TITLE: "Test ticket",
            TICKET_URL: "https://linear.app/test/issue/DEN-1",
            TICKET_TEAM: "DEN",
            TICKET_TAGS: "repo:blueden,priority:high",
            TICKET_DESCRIPTION: "A test",
            AGENT_WORKDIR: join(workspaceDir, "agent"),
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when neither builderCommand nor builderPath is provided", async () => {
    const { runWorkspaceBuilder } = await import("./clone.js");
    const root = await mkdtempRoot();
    try {
      await expect(
        runWorkspaceBuilder({ workspaceDir: join(root, "ws"), githubToken: "tok", ticket }),
      ).rejects.toThrow("WORKSPACE_BUILDER_COMMAND or WORKSPACE_BUILDER_PATH");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when both builderCommand and builderPath are provided", async () => {
    const { runWorkspaceBuilder } = await import("./clone.js");
    const root = await mkdtempRoot();
    try {
      await expect(
        runWorkspaceBuilder({
          workspaceDir: join(root, "ws"),
          githubToken: "tok",
          ticket,
          builderCommand: "echo hi",
          builderPath: "/some/script.sh",
        }),
      ).rejects.toThrow("mutually exclusive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkdtempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bear-metal-clone-"));
}
