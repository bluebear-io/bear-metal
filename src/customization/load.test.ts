import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBearMetalConfig, resolveSecret, validateBearMetalConfig, validateTaskCustomization } from "./load.js";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const valid = () => ({
  linear: { clientId: "linear", getClientSecret: vi.fn(() => "secret") },
  github: { appId: 1, installationId: 2, getPrivateKey: vi.fn(() => "private") },
  llmProviders: {},
  customizeTask: vi.fn(),
});

describe("configuration validation", () => {
  it("requires the bootstrap variable", async () => await expect(loadBearMetalConfig({})).rejects.toThrow("BEAR_METAL_CONFIG_FILE"));
  it("loads JavaScript and native TypeScript modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bear-metal-config-test-")); paths.push(dir);
    await writeFile(join(dir, "package.json"), `{ "type": "module" }`);
    for (const extension of ["js", "mjs", "ts", "mts"]) {
      const path = join(dir, `config.${extension}`);
      await writeFile(path, `export default { linear: { clientId: "id", getClientSecret: () => "secret" }, github: { appId: 1, installationId: 2, getPrivateKey: () => "key" }, llmProviders: {}, customizeTask: (task${extension === "mts" ? ": unknown" : ""}) => task }`);
      await expect(loadBearMetalConfig({ BEAR_METAL_CONFIG_FILE: path })).resolves.toMatchObject({ llmProviders: {} });
    }
  });
  it("does not invoke getters while validating structure", () => {
    const config = valid(); validateBearMetalConfig(config);
    expect(config.linear.getClientSecret).not.toHaveBeenCalled(); expect(config.github.getPrivateKey).not.toHaveBeenCalled();
  });
  it("keeps ambient Bedrock out of the key-based provider registry", () => {
    expect(() => validateBearMetalConfig({ ...valid(), llmProviders: { "amazon-bedrock": {} } })).toThrow("config.llmProviders.amazon-bedrock: unsupported provider");
  });
  it("requires an explicit supported customization shape", () => {
    expect(() => validateTaskCustomization({ llm: { provider: "anthropic", model: "model" }, buildWorkspace() {}, limits: { maxTokens: 0 } })).toThrow("maxTokens");
  });
  it("rejects empty resolved secrets", async () => await expect(resolveSecret(async () => "", "secret getter")).rejects.toThrow("non-empty"));
});
