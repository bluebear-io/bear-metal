import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBearMetalConfig, resolveSlackIntakePolicy, resolveSecret, validateBearMetalConfig, validateTaskCustomization } from "./load.js";

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
  it("rejects the removed top-level intake configuration", () => {
    expect(() => validateBearMetalConfig({ ...valid(), slack: { notificationChannel: "C1", getBotToken: () => "token", customerIntake: {} } })).toThrow("customizeTask");
  });
  it("validates intake policy returned by customizeTask", () => {
    const intake = { channelNamePattern: /^support-.+$/, triggerReaction: "ticket", ownerEmail: "owner@example.com",
      sweepIntervalMs: 3600000, initialLookbackMs: 7200000, readOnlyChannels: true,
      isEligibleReactor: () => true, reactionInstructions: "Track the flagged request.", sweepInstructions: "Find unresolved requests." };
    const withIntake = (overrides: object) => ({ llm: { provider: "anthropic", model: "model" }, buildWorkspace: async () => {}, slackIntake: { ...intake, ...overrides } });
    expect(validateTaskCustomization(withIntake({})).slackIntake?.sweepIntervalMs).toBe(3600000);
    expect(() => validateTaskCustomization(withIntake({ channelNamePattern: "support-" }))).toThrow("RegExp");
    expect(() => validateTaskCustomization(withIntake({ channelNamePattern: /support-/g }))).toThrow("g or y");
    expect(() => validateTaskCustomization(withIntake({ triggerReaction: ":ticket:" }))).toThrow("emoji name");
    expect(() => validateTaskCustomization(withIntake({ ownerEmail: "owner" }))).toThrow("email");
    for (const field of ["sweepIntervalMs", "initialLookbackMs"]) {
      expect(() => validateTaskCustomization(withIntake({ [field]: 0 }))).toThrow(field);
    }
    expect(() => validateTaskCustomization(withIntake({ readOnlyChannels: undefined }))).toThrow("readOnlyChannels");
    expect(() => validateTaskCustomization(withIntake({ isEligibleReactor: undefined }))).toThrow("isEligibleReactor");
    expect(() => validateTaskCustomization(withIntake({ sweepInstructions: "" }))).toThrow("sweepInstructions");
  });
  it("resolves optional intake exclusively through the startup customization call", async () => {
    const buildWorkspace = vi.fn(async () => {});
    const customizeTask = vi.fn(async () => ({ llm: { provider: "anthropic" as const, model: "model" }, buildWorkspace }));
    const config = { ...valid(), customizeTask, slack: { notificationChannel: "C1", getBotToken: () => "token" } };
    await expect(resolveSlackIntakePolicy(config)).resolves.toBeUndefined();
    expect(customizeTask).toHaveBeenCalledExactlyOnceWith({ type: "coordinator", id: "slack-intake-configuration", trigger: "slack", slackIntake: "configure" });
    expect(buildWorkspace).not.toHaveBeenCalled();
    customizeTask.mockClear();
    await expect(resolveSlackIntakePolicy({ ...config, slack: undefined })).resolves.toBeUndefined();
    expect(customizeTask).not.toHaveBeenCalled();
  });

  it("requires a signing secret when the customization enables intake", async () => {
    const policy = { channelNamePattern: /^support-/, triggerReaction: "ticket", ownerEmail: "owner@example.com",
      sweepIntervalMs: 3600000, initialLookbackMs: 7200000, readOnlyChannels: true,
      isEligibleReactor: () => true, reactionInstructions: "Track request.", sweepInstructions: "Review requests." };
    const config = { ...valid(), slack: { notificationChannel: "C1", getBotToken: () => "token" },
      customizeTask: async () => ({ llm: { provider: "anthropic" as const, model: "model" }, buildWorkspace: async () => {}, slackIntake: policy }) };
    await expect(resolveSlackIntakePolicy(config)).rejects.toThrow("getSigningSecret");
    await expect(resolveSlackIntakePolicy({ ...config, slack: { ...config.slack, getSigningSecret: () => "secret" } })).resolves.toEqual(policy);
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
  it("validates trace retention overrides", () => {
    expect(validateBearMetalConfig({ ...valid(), traceRetentionDays: 30 }).traceRetentionDays).toBe(30);
    expect(() => validateBearMetalConfig({ ...valid(), traceRetentionDays: 0 })).toThrow("config.traceRetentionDays");
  });
  it("accepts only a callable CI retry policy", () => {
    const shouldRetryCi = vi.fn(() => false);
    expect(validateBearMetalConfig({ ...valid(), shouldRetryCi }).shouldRetryCi).toBe(shouldRetryCi);
    expect(() => validateBearMetalConfig({ ...valid(), shouldRetryCi: true })).toThrow("config.shouldRetryCi");
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
  it("accepts any Bedrock ARN as modelArn and rejects any other use of it", () => {
    const customization = (llm: Record<string, unknown>) => ({ llm, buildWorkspace() {} });
    const model = "us.anthropic.claude-sonnet-5-5";
    for (const arn of [
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123def456",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-5",
      "arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-sonnet-5-5",
    ]) {
      expect(validateTaskCustomization(customization({ provider: "amazon-bedrock", model, modelArn: arn })).llm.modelArn).toBe(arn);
    }
    expect(() => validateTaskCustomization(customization({ provider: "anthropic", model: "claude-opus-5-5", modelArn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc" }))).toThrow("customizeTask result.llm.modelArn");
    for (const invalid of ["", "us.anthropic.claude-sonnet-5-5", 7]) {
      expect(() => validateTaskCustomization(customization({ provider: "amazon-bedrock", model, modelArn: invalid }))).toThrow("customizeTask result.llm.modelArn");
    }
  });
  it("rejects empty resolved secrets", async () => await expect(resolveSecret(async () => "", "secret getter")).rejects.toThrow("non-empty"));
});
