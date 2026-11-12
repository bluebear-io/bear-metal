import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffSinceBase, prepareScratchCheckout, pushScratch } from "./scratch-git.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("scratch branch git", () => {
  let base: string;
  let remote: string;
  let checkout: string;
  let baseSha: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "bear-metal-scratch-test-"));
    vi.stubEnv("GIT_AUTHOR_NAME", "Test"); vi.stubEnv("GIT_AUTHOR_EMAIL", "test@example.com");
    vi.stubEnv("GIT_COMMITTER_NAME", "Test"); vi.stubEnv("GIT_COMMITTER_EMAIL", "test@example.com");
    remote = join(base, "remote.git");
    git(base, "init", "--bare", "--quiet", "-b", "main", remote);
    checkout = join(base, "checkout");
    git(base, "clone", "--quiet", remote, checkout);
    await writeFile(join(checkout, "README.md"), "hello\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "--quiet", "-m", "initial");
    git(checkout, "push", "--quiet", "origin", "HEAD:main");
    baseSha = git(checkout, "rev-parse", "HEAD");
    git(checkout, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  it("starts the scratch branch only on the requested repository and base SHA", async () => {
    await expect(prepareScratchCheckout(checkout, { repository: "acme/widgets", baseSha: "b".repeat(40), scratchBranch: null }))
      .rejects.toThrow("not the requested base");
    await expect(prepareScratchCheckout(checkout, { repository: "acme/other", baseSha, scratchBranch: null }))
      .rejects.toThrow("not acme/other");
    await prepareScratchCheckout(checkout, { repository: "acme/widgets", baseSha, scratchBranch: "wf/run/r1/dev" });
    expect(git(checkout, "branch", "--show-current")).toBe("wf/run/r1/dev");
  });

  it("commits and pushes only to the scratch branch, without running repository hooks", async () => {
    await prepareScratchCheckout(checkout, { repository: "acme/widgets", baseSha, scratchBranch: "wf/run/r1/dev" });
    const marker = join(base, "hook-ran");
    for (const hook of ["pre-commit", "pre-push"]) {
      await writeFile(join(checkout, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`);
      await chmod(join(checkout, ".git", "hooks", hook), 0o755);
    }
    await writeFile(join(checkout, "README.md"), "changed\n");
    const pushed = await pushScratch({
      repoRoot: checkout, repository: "acme/widgets", baseSha, branch: "wf/run/r1/dev", message: "Change readme", token: "token", remoteUrl: remote,
    });
    expect(pushed.commits).toHaveLength(1);
    expect(pushed.commits[0]).toBe(pushed.sha);
    expect(git(remote, "rev-parse", "refs/heads/wf/run/r1/dev")).toBe(pushed.sha);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(baseSha);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to push nothing or history that does not descend from the base", async () => {
    await prepareScratchCheckout(checkout, { repository: "acme/widgets", baseSha, scratchBranch: "wf/run/r1/dev" });
    const push = () => pushScratch({ repoRoot: checkout, repository: "acme/widgets", baseSha, branch: "wf/run/r1/dev", message: "m", token: "t", remoteUrl: remote });
    await expect(push()).rejects.toThrow("Nothing to push");
    git(checkout, "checkout", "--quiet", "--orphan", "unrelated");
    await writeFile(join(checkout, "other.txt"), "x\n");
    await expect(push()).rejects.toThrow("does not descend from the base SHA");
  });

  it("includes uncommitted and new files in the diff since the base", async () => {
    await writeFile(join(checkout, "new.txt"), "new\n");
    const diff = await diffSinceBase(checkout, baseSha);
    expect(diff).toContain("new.txt");
  });
});
