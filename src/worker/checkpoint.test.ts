import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../shared/command.js";
import { restoreCheckpoint, saveCheckpoint } from "./checkpoint.js";

const dirs: string[] = [];
const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com" };
const git = (cwd: string, ...args: string[]) => runCommand("git", args, { cwd, env, timeoutMs: 10_000 });
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bm-checkpoint-"));
  dirs.push(root);
  const remote = join(root, "remote.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await git(root, "init", "--bare", remote);
  await git(workspace, "init", "-b", "main");
  await writeFile(join(workspace, "tracked.txt"), "base");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "base");
  await git(workspace, "remote", "add", "origin", remote);
  await git(workspace, "push", "-u", "origin", "main");
  return { root, remote, workspace };
}

describe("checkpoint integration", () => {
  it.each(["dirty", "clean", "unpushed"])("saves and resumes a %s task", async (state) => {
    const { root, remote, workspace } = await fixture();
    await git(workspace, "switch", "-c", "feature/den-4880");
    if (state !== "clean") {
      await writeFile(join(workspace, "tracked.txt"), "finished preparation");
      await writeFile(join(workspace, "new.txt"), "unfinished implementation");
    }
    if (state === "unpushed") {
      await git(workspace, "add", ".");
      await git(workspace, "commit", "-m", "preparation");
    }
    const before = (await git(workspace, "rev-parse", "HEAD")).stdout.trim();
    const checkpoint = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    expect(checkpoint.error).toBeNull();
    expect(checkpoint.repositories).toHaveLength(1);
    expect(checkpoint.repositories[0]?.pushed).toBe(true);
    if (state !== "dirty") expect(checkpoint.repositories[0]?.commit).toBe(before);
    else expect((await git(workspace, "log", "-1", "--format=%s")).stdout).toContain("unfinished");
    const again = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    expect(again.repositories[0]?.commit).toBe(checkpoint.repositories[0]?.commit);
    const resumed = join(root, "resumed");
    await git(root, "clone", "--branch", "main", remote, resumed);
    await restoreCheckpoint(resumed, checkpoint, env);
    expect((await git(resumed, "rev-parse", "HEAD")).stdout.trim()).toBe(checkpoint.repositories[0]?.commit);
    expect((await git(resumed, "branch", "--show-current")).stdout.trim()).toBe("feature/den-4880");
    if (state !== "clean") expect(await readFile(join(resumed, "new.txt"), "utf8")).toBe("unfinished implementation");
  });

  it("preserves and restores both umbrella and nested repositories", async () => {
    const { root, remote, workspace } = await fixture();
    const child = await fixture();
    await writeFile(join(workspace, ".gitignore"), "nested/\n");
    await git(workspace, "add", ".gitignore");
    await git(workspace, "commit", "-m", "ignore nested repo");
    await git(workspace, "push");
    await git(workspace, "clone", "--branch", "main", child.remote, "nested");
    await writeFile(join(workspace, "parent.txt"), "parent work");
    await writeFile(join(workspace, "nested/child.txt"), "child work");
    const checkpoint = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    expect(checkpoint.repositories.map((repo) => [repo.path, repo.pushed])).toEqual([["nested", true], [".", true]]);
    const resumed = join(root, "resumed");
    await git(root, "clone", "--branch", "main", remote, resumed);
    await git(resumed, "clone", "--branch", "main", child.remote, "nested");
    await restoreCheckpoint(resumed, checkpoint, env);
    expect(await readFile(join(resumed, "parent.txt"), "utf8")).toBe("parent work");
    expect(await readFile(join(resumed, "nested/child.txt"), "utf8")).toBe("child work");
  });

  it("refuses to overwrite unpushed commits created by a workspace builder", async () => {
    const { root, remote, workspace } = await fixture();
    const checkpoint = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    const resumed = join(root, "resumed");
    await git(root, "clone", "--branch", "feature/den-4880", remote, resumed);
    await writeFile(join(resumed, "builder.txt"), "local setup");
    await git(resumed, "add", ".");
    await git(resumed, "commit", "-m", "local preparation");
    const before = (await git(resumed, "rev-parse", "HEAD")).stdout;
    await expect(restoreCheckpoint(resumed, checkpoint, env)).rejects.toThrow();
    expect((await git(resumed, "rev-parse", "HEAD")).stdout).toBe(before);
  });

  it.each(["commit", "push"])("reports a rejected %s and retains local work", async (failure) => {
    const { workspace, remote } = await fixture();
    await writeFile(join(workspace, "new.txt"), "unsaved work");
    const hook = failure === "commit" ? join(workspace, ".git/hooks/pre-commit") : join(remote, "hooks/pre-receive");
    await writeFile(hook, "#!/bin/sh\necho checkpoint-rejected >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const checkpoint = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    expect(checkpoint.repositories[0]?.pushed).toBe(false);
    expect(checkpoint.repositories[0]?.error).toContain("checkpoint-rejected");
    expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("unsaved work");
    await expect(restoreCheckpoint(workspace, checkpoint, env)).rejects.toThrow();
    await rm(hook);
    const repaired = await saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env });
    expect(repaired.repositories[0]?.pushed).toBe(true);
    // Stored push failure is stale after manual repair; restoration verifies the actual remote.
    await restoreCheckpoint(workspace, failure === "push" ? checkpoint : repaired, env);
  });

  it("does not commit or push when lease verification fails", async () => {
    const { workspace, remote } = await fixture();
    await writeFile(join(workspace, "new.txt"), "local work");
    await expect(saveCheckpoint({ workspaceRoot: workspace, branch: "feature/den-4880", ticketId: "DEN-4880", gitEnv: env,
      assertLease: async () => { throw new Error("Lease lost"); },
    })).rejects.toThrow("Lease lost");
    expect((await git(remote, "branch", "--list", "feature/den-4880")).stdout.trim()).toBe("");
    expect((await git(workspace, "status", "--porcelain")).stdout).toContain("new.txt");
  });
});
