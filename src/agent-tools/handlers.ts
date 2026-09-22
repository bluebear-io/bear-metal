import type { TokenProvider } from "../shared/integrations/linear/token.js";
import { createGitHubDispatchHandler, type GitHubDispatchPolicy, type GitHubDispatchTokenProvider } from "./github-dispatch.js";
import { createGitHubReadHandler, type GitHubReadTokenProvider } from "./github-read.js";
import { createLinearReadHandler } from "./linear-read.js";
import { createSlackReadHandler, type SlackReadClientLike } from "./slack-read.js";
import type { AgentToolHandlers } from "./types.js";
import { createWebGetHandler } from "./web-get.js";

export type AgentToolCapabilities = {
  github?: GitHubReadTokenProvider & GitHubDispatchTokenProvider;
  linear?: TokenProvider;
  slack?: SlackReadClientLike;
  githubDispatchPolicy?: GitHubDispatchPolicy;
  web?: { allowHttp?: boolean };
};

export function createAgentToolHandlers(capabilities: AgentToolCapabilities): AgentToolHandlers {
  const handlers: AgentToolHandlers = {};
  if (capabilities.github) {
    handlers.github_read = createGitHubReadHandler({ tokenProvider: capabilities.github });
    if (capabilities.githubDispatchPolicy) {
      handlers.github_dispatch = createGitHubDispatchHandler({ tokenProvider: capabilities.github, policy: capabilities.githubDispatchPolicy });
    }
  }
  if (capabilities.linear) handlers.linear_read = createLinearReadHandler({ tokenProvider: capabilities.linear });
  if (capabilities.slack) handlers.slack_read = createSlackReadHandler({ client: capabilities.slack });
  if (capabilities.web) handlers.web_get = createWebGetHandler({ allowHttp: capabilities.web.allowHttp });
  return handlers;
}
