import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoordinatorWorkspaceCache } from "./coordinator-workspace.js";

describe("CoordinatorWorkspaceCache", () => {
  it("shares builds and keeps active readers on the old generation during refresh", async () => {
    const base = await mkdtemp(join(tmpdir(), "bear-metal-coordinator-cache-test-"));
    vi.stubEnv("BEAR_METAL_WORKSPACE_DIR", base);
    const orphan = join(base, "coordinator", "orphan");
    await mkdir(orphan, { recursive: true });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new CoordinatorWorkspaceCache();
    let builds = 0;
    const buildWorkspace = async ({ workspacePath }: { workspacePath: string }) => {
      builds++;
      await writeFile(join(workspacePath, "AGENTS.md"), `generation ${builds}`);
    };
    const getGithubToken = async () => "token";
    try {
      const [first, second] = await Promise.all([
        cache.acquire(buildWorkspace, getGithubToken),
        cache.acquire(buildWorkspace, getGithubToken),
      ]);
      expect(builds).toBe(1);
      expect(existsSync(orphan)).toBe(false);
      expect(second.agentWorkdir).toBe(first.agentWorkdir);
      expect(first.agentsMd).toBe("generation 1");
      await second.release();

      now += 24 * 60 * 60 * 1000;
      const refreshed = await cache.acquire(buildWorkspace, getGithubToken);
      expect(builds).toBe(2);
      expect(refreshed.agentWorkdir).not.toBe(first.agentWorkdir);
      expect(refreshed.agentsMd).toBe("generation 2");
      expect(existsSync(first.agentWorkdir)).toBe(true);
      await first.release();
      expect(existsSync(first.agentWorkdir)).toBe(false);
      await refreshed.release();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(base, { recursive: true, force: true });
    }
  });
});
