import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TaskCustomization } from "../customization/types.js";
import { runWorkspaceBuilder, workspaceForCoordinatorGeneration, workspaceForCoordinatorRoot } from "./clone.js";

const REFRESH_MS = 24 * 60 * 60 * 1000;

type Generation = {
  workspaceDir: string;
  agentWorkdir: string;
  agentsMd: string;
  builtAt: number;
  readers: number;
  retired: boolean;
};

export class CoordinatorWorkspaceCache {
  private current: Generation | undefined;
  private pending: Promise<void> | undefined;
  private initialized = false;

  async acquire(
    buildWorkspace: TaskCustomization["buildWorkspace"],
    getGithubToken: () => Promise<string>,
  ): Promise<{ agentWorkdir: string; agentsMd: string; release: () => Promise<void> }> {
    if (!this.current || Date.now() - this.current.builtAt >= REFRESH_MS) {
      if (!this.pending) {
        const pending = this.refresh(buildWorkspace, getGithubToken);
        this.pending = pending;
        const clearPending = () => { if (this.pending === pending) this.pending = undefined; };
        void pending.then(clearPending, clearPending);
      }
      await this.pending;
    }
    const generation = this.current;
    if (!generation) throw new Error("Coordinator workspace is unavailable");
    generation.readers++;
    return {
      agentWorkdir: generation.agentWorkdir,
      agentsMd: generation.agentsMd,
      release: async () => {
        generation.readers--;
        if (generation.readers < 0) throw new Error("Coordinator workspace released more than once");
        if (generation.retired && generation.readers === 0) await rm(generation.workspaceDir, { recursive: true, force: true });
      },
    };
  }

  private async refresh(
    buildWorkspace: TaskCustomization["buildWorkspace"],
    getGithubToken: () => Promise<string>,
  ): Promise<void> {
    if (!this.initialized) {
      await rm(workspaceForCoordinatorRoot(), { recursive: true, force: true });
      this.initialized = true;
    }
    const workspaceDir = workspaceForCoordinatorGeneration(randomUUID());
    const built = await runWorkspaceBuilder({ workspaceDir, githubToken: await getGithubToken(), buildWorkspace });
    let agentsMd: string;
    try {
      agentsMd = await readFile(join(built.agentWorkdir, "AGENTS.md"), "utf8");
      if (!agentsMd.trim()) throw new Error(`Coordinator AGENTS.md is empty: ${built.agentWorkdir}`);
    } catch (error) {
      await rm(workspaceDir, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(built.netrcDir, { recursive: true, force: true });
    }
    const previous = this.current;
    this.current = { workspaceDir, agentWorkdir: built.agentWorkdir, agentsMd, builtAt: Date.now(), readers: 0, retired: false };
    if (previous) {
      previous.retired = true;
      if (previous.readers === 0) await rm(previous.workspaceDir, { recursive: true, force: true });
    }
  }
}
