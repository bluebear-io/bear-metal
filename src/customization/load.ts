import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BearMetalConfig, LlmProvider, SecretGetter, TaskCustomization } from "./types.js";

const ALLOWED_EXTENSIONS = [".js", ".mjs", ".ts", ".mts"] as const;
const PROVIDERS = new Set<LlmProvider>(["anthropic", "openai", "google", "amazon-bedrock"]);
const KEY_BASED_PROVIDERS = new Set(["anthropic", "openai", "google"]);

export async function loadBearMetalConfig(env: NodeJS.ProcessEnv = process.env): Promise<Readonly<BearMetalConfig>> {
  const configuredPath = env.BEAR_METAL_CONFIG_FILE?.trim();
  if (!configuredPath) throw new Error("Missing required environment variable: BEAR_METAL_CONFIG_FILE");
  const path = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  if (!ALLOWED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    throw new Error(`BEAR_METAL_CONFIG_FILE must end in ${ALLOWED_EXTENSIONS.join(", ")}: ${path}`);
  }
  await access(path).catch((cause) => { throw new Error(`Cannot read BEAR_METAL_CONFIG_FILE at ${path}`, { cause }); });
  const imported = await import(pathToFileURL(path).href).catch((cause) => {
    throw new Error(`Failed to import BEAR_METAL_CONFIG_FILE at ${path}`, { cause });
  });
  return validateBearMetalConfig(imported.default);
}

export function validateBearMetalConfig(value: unknown): Readonly<BearMetalConfig> {
  const config = object(value, "config default export");
  const linear = object(config.linear, "config.linear");
  nonEmptyString(linear.clientId, "config.linear.clientId");
  if (linear.oauthScopes !== undefined) nonEmptyString(linear.oauthScopes, "config.linear.oauthScopes");
  callable(linear.getClientSecret, "config.linear.getClientSecret");
  const github = object(config.github, "config.github");
  positiveInteger(github.appId, "config.github.appId");
  positiveInteger(github.installationId, "config.github.installationId");
  callable(github.getPrivateKey, "config.github.getPrivateKey");
  if (config.slack !== undefined) {
    const slack = object(config.slack, "config.slack");
    nonEmptyString(slack.notificationChannel, "config.slack.notificationChannel");
    callable(slack.getBotToken, "config.slack.getBotToken");
  }
  if (config.agentIntegrations !== undefined) {
    const agentIntegrations = object(config.agentIntegrations, "config.agentIntegrations");
    if (agentIntegrations.github !== undefined) {
      const agentGithub = object(agentIntegrations.github, "config.agentIntegrations.github");
      positiveInteger(agentGithub.appId, "config.agentIntegrations.github.appId");
      positiveInteger(agentGithub.installationId, "config.agentIntegrations.github.installationId");
      callable(agentGithub.getPrivateKey, "config.agentIntegrations.github.getPrivateKey");
      if (agentGithub.dispatch !== undefined) {
        const dispatch = object(agentGithub.dispatch, "config.agentIntegrations.github.dispatch");
        nonEmptyStringArray(dispatch.repositories, "config.agentIntegrations.github.dispatch.repositories");
        nonEmptyStringArray(dispatch.workflows, "config.agentIntegrations.github.dispatch.workflows");
        nonEmptyStringArray(dispatch.refs, "config.agentIntegrations.github.dispatch.refs");
      }
    }
    if (agentIntegrations.linear !== undefined) {
      const agentLinear = object(agentIntegrations.linear, "config.agentIntegrations.linear");
      nonEmptyString(agentLinear.clientId, "config.agentIntegrations.linear.clientId");
      if (agentLinear.oauthScopes !== undefined) nonEmptyString(agentLinear.oauthScopes, "config.agentIntegrations.linear.oauthScopes");
      callable(agentLinear.getClientSecret, "config.agentIntegrations.linear.getClientSecret");
    }
    if (agentIntegrations.slack !== undefined) {
      const agentSlack = object(agentIntegrations.slack, "config.agentIntegrations.slack");
      callable(agentSlack.getBotToken, "config.agentIntegrations.slack.getBotToken");
    }
    if (agentIntegrations.web !== undefined) {
      const agentWeb = object(agentIntegrations.web, "config.agentIntegrations.web");
      if (agentWeb.allowHttp !== undefined && typeof agentWeb.allowHttp !== "boolean") {
        throw new Error("config.agentIntegrations.web.allowHttp must be a boolean");
      }
    }
  }
  if (config.database !== undefined) callable(object(config.database, "config.database").getUrl, "config.database.getUrl");
  if (config.maxIterations !== undefined) positiveInteger(config.maxIterations, "config.maxIterations");
  if (config.ciDeferralMaxMs !== undefined) positiveInteger(config.ciDeferralMaxMs, "config.ciDeferralMaxMs");
  const registry = object(config.llmProviders, "config.llmProviders");
  for (const [provider, definition] of Object.entries(registry)) {
    if (!KEY_BASED_PROVIDERS.has(provider)) throw new Error(`config.llmProviders.${provider}: unsupported provider`);
    const entry = object(definition, `config.llmProviders.${provider}`);
    callable(entry.getApiKey, `config.llmProviders.${provider}.getApiKey`);
  }
  callable(config.customizeTask, "config.customizeTask");
  return Object.freeze(value as BearMetalConfig);
}

export function validateTaskCustomization(value: unknown): TaskCustomization {
  const customization = object(value, "customizeTask result");
  const llm = object(customization.llm, "customizeTask result.llm");
  nonEmptyString(llm.provider, "customizeTask result.llm.provider");
  if (!PROVIDERS.has(llm.provider as LlmProvider)) throw new Error(`customizeTask result.llm.provider: unsupported provider ${llm.provider}`);
  nonEmptyString(llm.model, "customizeTask result.llm.model");
  callable(customization.buildWorkspace, "customizeTask result.buildWorkspace");
  if (customization.additionalSystemPrompt !== undefined && customization.additionalSystemPrompt !== null && typeof customization.additionalSystemPrompt !== "string") {
    throw new Error("customizeTask result.additionalSystemPrompt must be a string or null");
  }
  if (customization.limits !== undefined) {
    const limits = object(customization.limits, "customizeTask result.limits");
    if (limits.maxDurationMs !== undefined) positiveInteger(limits.maxDurationMs, "customizeTask result.limits.maxDurationMs");
    if (limits.maxTokens !== undefined) positiveInteger(limits.maxTokens, "customizeTask result.limits.maxTokens");
  }
  return value as TaskCustomization;
}

export async function resolveSecret(getter: SecretGetter, field: string): Promise<string> {
  const value = await getter();
  return nonEmptyString(value, field);
}

function object(value: unknown, field: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, any>;
}
function callable(value: unknown, field: string): asserts value is (...args: any[]) => any {
  if (typeof value !== "function") throw new Error(`${field} must be a function`);
}
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}
function nonEmptyStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  for (const [index, entry] of value.entries()) nonEmptyString(entry, `${field}[${index}]`);
  return value as string[];
}
