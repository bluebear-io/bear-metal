import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("Pi model compatibility", () => {
  it("resolves upgraded coding and existing research models from the real SDK", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    for (const [provider, id] of [
      ["anthropic", "claude-opus-5-5"],
      ["anthropic", "claude-opus-4-7"],
      ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"],
    ] as const) {
      expect(runtime.getModel(provider, id), `${provider}/${id}`).toMatchObject({ provider, id });
    }
  });

  it("creates a real 5.5 session using the supplied runtime credentials and tool allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bear-metal-pi-model-test-"));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models-store.json"),
        refreshOnCreate: false,
      });
      await runtime.setRuntimeApiKey("anthropic", "regression-test-key");
      expect(await runtime.getAuth("anthropic")).toMatchObject({ auth: { apiKey: "regression-test-key" } });
      const model = runtime.getModel("anthropic", "claude-opus-5-5");
      expect(model).toBeDefined();
      const { session } = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model,
        sessionManager: SessionManager.inMemory(),
        tools: ["read"],
      });
      try {
        expect(session.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
        expect(session.modelRuntime).toBe(runtime);
        expect(session.getActiveToolNames()).toEqual(["read"]);
      } finally {
        session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
