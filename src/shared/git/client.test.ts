import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll } from "./client.js";

const exec = promisify(execFile);
const env = { GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@example.com" };
const git = async (repo: string, ...args: string[]) => (await exec("git", args, { cwd: repo, env: { ...process.env, ...env } })).stdout.trim();

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "bear-metal-commit-test-"));
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "start\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe("commitAll", () => {
  it("creates the task branch, commits new and changed files, and reuses the branch on the next commit", async () => {
    await writeFile(join(repo, "README.md"), "changed\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    const first = await commitAll(repo, "feat/ABC-1/cleanup", "chore: first", env);
    expect(await git(repo, "branch", "--show-current")).toBe("feat/ABC-1/cleanup");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(first);
    expect(await git(repo, "log", "-1", "--format=%s")).toBe("chore: first");
    expect(await git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("README.md\nnew.txt");

    await writeFile(join(repo, "new.txt"), "again\n");
    await commitAll(repo, "feat/ABC-1/cleanup", "chore: second", env);
    expect(await git(repo, "log", "--format=%s", "main..HEAD")).toBe("chore: second\nchore: first");
  });

  it("refuses main, invalid branch names and empty commits without committing", async () => {
    await writeFile(join(repo, "README.md"), "changed\n");
    await expect(commitAll(repo, "main", "x", env)).rejects.toThrow("Refusing to commit task changes directly on main");
    await expect(commitAll(repo, "bad..name", "x", env)).rejects.toThrow("check-ref-format");
    await git(repo, "checkout", "--", "README.md");
    await expect(commitAll(repo, "feat/ABC-1/empty", "x", env)).rejects.toThrow("has no changes to commit");
    expect(await git(repo, "log", "--format=%s", "--all")).toBe("init");
  });
});
