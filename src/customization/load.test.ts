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
  agentIntegrations: {
    linear: { clientId: "agent-linear", getClientSecret: vi.fn(() => "agent-secret") },
    github: { appId: 3, installationId: 4, getPrivateKey: vi.fn(() => "agent-private") },
    slack: { getBotToken: vi.fn(() => "agent-slack") },
    web: {} as { allowHttp?: boolean },
  },
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
      await writeFile(path, `export default { linear: { clientId: "id", getClientSecret: () => "secret" }, github: { appId: 1, installationId: 2, getPrivateKey: () => "key" }, agentIntegrations: { linear: { clientId: "agent-id", getClientSecret: () => "secret" }, github: { appId: 3, installationId: 4, getPrivateKey: () => "key" }, slack: { getBotToken: () => "token" } }, llmProviders: {}, customizeTask: (task${extension === "mts" ? ": unknown" : ""}) => task }`);
      await expect(loadBearMetalConfig({ BEAR_METAL_CONFIG_FILE: path })).resolves.toMatchObject({ llmProviders: {} });
    }
  });
  it("does not invoke getters while validating structure", () => {
    const config = valid(); validateBearMetalConfig(config);
    expect(config.linear.getClientSecret).not.toHaveBeenCalled(); expect(config.github.getPrivateKey).not.toHaveBeenCalled();
    expect(config.agentIntegrations.linear.getClientSecret).not.toHaveBeenCalled();
    expect(config.agentIntegrations.github.getPrivateKey).not.toHaveBeenCalled();
    expect(config.agentIntegrations.slack.getBotToken).not.toHaveBeenCalled();
  });
  it("accepts omitted and independently configured agent integrations", () => {
    const config = valid();
    expect(validateBearMetalConfig({ ...config, agentIntegrations: undefined }).agentIntegrations).toBeUndefined();
    expect(validateBearMetalConfig({ ...config, agentIntegrations: { github: config.agentIntegrations.github } }).agentIntegrations?.github).toBeDefined();
    expect(validateBearMetalConfig({ ...config, agentIntegrations: { linear: config.agentIntegrations.linear } }).agentIntegrations?.linear).toBeDefined();
    expect(validateBearMetalConfig({ ...config, agentIntegrations: { slack: config.agentIntegrations.slack } }).agentIntegrations?.slack).toBeDefined();
  });
  it("validates credentials for each configured agent integration", () => {
    const config = valid();
    expect(() => validateBearMetalConfig({ ...config, agentIntegrations: { ...config.agentIntegrations, slack: {} } })).toThrow("config.agentIntegrations.slack.getBotToken");
  });
  it("accepts a frozen agent Linear config without mutating it", () => {
    const config = valid();
    config.agentIntegrations!.linear = Object.freeze(config.agentIntegrations!.linear!);
    expect(validateBearMetalConfig(config).agentIntegrations!.linear!.oauthScopes).toBeUndefined();
  });
  it("validates the optional GitHub workflow dispatch policy", () => {
    const config = valid();
    const github = config.agentIntegrations!.github as NonNullable<typeof config.agentIntegrations>["github"] & { dispatch?: unknown };
    github.dispatch = { repositories: ["acme/widgets"], workflows: ["release.yml"], refs: ["main"] };
    expect(validateBearMetalConfig(config).agentIntegrations!.github!.dispatch).toEqual(github.dispatch);
    github.dispatch = { repositories: [], workflows: ["release.yml"], refs: ["main"] };
    expect(() => validateBearMetalConfig(config)).toThrow("config.agentIntegrations.github.dispatch.repositories");
  });
  it("validates the optional CI deferral timeout", () => {
    expect(validateBearMetalConfig({ ...valid(), ciDeferralMaxMs: 7_200_000 }).ciDeferralMaxMs).toBe(7_200_000);
    expect(() => validateBearMetalConfig({ ...valid(), ciDeferralMaxMs: 0 })).toThrow("config.ciDeferralMaxMs");
  });

  it("validates the optional anonymous web transport configuration", () => {
    const config = valid();
    config.agentIntegrations!.web = { allowHttp: true };
    expect(validateBearMetalConfig(config).agentIntegrations!.web).toEqual({ allowHttp: true });
    (config.agentIntegrations!.web as { allowHttp?: unknown }).allowHttp = "yes";
    expect(() => validateBearMetalConfig(config)).toThrow("config.agentIntegrations.web.allowHttp");
  });
  it("keeps ambient Bedrock out of the key-based provider registry", () => {
    expect(() => validateBearMetalConfig({ ...valid(), llmProviders: { "amazon-bedrock": {} } })).toThrow("config.llmProviders.amazon-bedrock: unsupported provider");
  });
  it("requires an explicit supported customization shape", () => {
    expect(() => validateTaskCustomization({ llm: { provider: "anthropic", model: "model" }, buildWorkspace() {}, limits: { maxTokens: 0 } })).toThrow("maxTokens");
  });
  it("rejects empty resolved secrets", async () => await expect(resolveSecret(async () => "", "secret getter")).rejects.toThrow("non-empty"));
});
