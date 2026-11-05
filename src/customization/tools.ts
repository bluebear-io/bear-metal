import { AGENT_TOOL_CHOICES, type AgentToolChoice } from "./types.js";

export function isAgentToolChoice(name: string): name is AgentToolChoice {
  return (AGENT_TOOL_CHOICES as readonly string[]).includes(name);
}

/**
 * Keeps the tools a role allows, plus `alwaysKept`. Only removes: a tool missing from `tools` is never added.
 * `allowed` undefined means the task has no role list and keeps every tool.
 */
export function narrowTools<T extends { name: string }>(
  tools: readonly T[],
  allowed: readonly AgentToolChoice[] | undefined,
  alwaysKept: ReadonlySet<string> = new Set(),
): T[] {
  if (allowed === undefined) return [...tools];
  return tools.filter((tool) => alwaysKept.has(tool.name) || (isAgentToolChoice(tool.name) && allowed.includes(tool.name)));
}
