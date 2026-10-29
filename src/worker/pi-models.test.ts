import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveSessionModel } from "./model.js";

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

  it("runs a Bedrock catalog model under an application inference profile ARN", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123def456";
    const catalog = runtime.getModel("amazon-bedrock", "us.anthropic.claude-sonnet-5-5");
    expect(catalog).toBeDefined();
    expect(resolveSessionModel(runtime, { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-5-5", inferenceProfileArn: arn }))
      .toEqual({ ...catalog, id: arn });
    expect(resolveSessionModel(runtime, { provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-5-5", inferenceProfileArn: null })).toBe(catalog);
    expect(() => resolveSessionModel(runtime, { provider: "amazon-bedrock", model: "not-a-model", inferenceProfileArn: arn }))
      .toThrow('No model found for provider "amazon-bedrock" / model "not-a-model"');
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
