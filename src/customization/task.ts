import type { PullRequestContext, PullRequestRef } from "../shared/integrations/github/types.js";
import type { LinearTicketContext, TicketAttachment } from "../shared/integrations/linear/types.js";
import { resolveSecret, validateTaskCustomization } from "./load.js";
import type { BearMetalConfig, ResolvedLlm, Task, TaskPriority, TaskPullRequest, TaskStatusCategory } from "./types.js";

export function buildTask(input: {
  state: "new" | "iteration";
  iteration: number;
  ticket: LinearTicketContext;
  attachments: TicketAttachment[];
  prs: PullRequestRef[];
  pullRequests: PullRequestContext[];
}): Task {
  const issue = input.ticket.issue;
  const pullRequests = input.pullRequests.map((context, index) => normalizePullRequest(input.prs[index]!, context));
  const repositories = [...new Map(input.prs.map((pr) => [`${pr.owner}/${pr.repo}`, Object.freeze({ owner: pr.owner, name: pr.repo })])).values()];
  return deepFreeze({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    status: { name: issue.status.name, category: normalizeStatus(issue.status.type) },
    priority: normalizePriority(issue.priority),
    labels: [...issue.labels],
    project: issue.project ?? null,
    assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name ?? null, email: issue.assignee.email ?? null } : null,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    completedAt: issue.completedAt ?? null,
    canceledAt: issue.canceledAt ?? null,
    comments: input.ticket.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: comment.user ? { id: comment.user.id, name: comment.user.name, email: comment.user.email } : null,
    })),
    attachments: (input.ticket.attachments ?? input.attachments).map((attachment) => ({ id: attachment.id, title: attachment.title, url: attachment.url })),
    relations: (issue.relations ?? []).map((relation) => ({ type: relation.type, taskIdentifier: relation.taskIdentifier })),
    repositories,
    run: { kind: input.state, iteration: input.iteration },
    pullRequests,
  });
}

export async function customizeAndResolve(config: BearMetalConfig, task: Task): Promise<{ customization: ReturnType<typeof validateTaskCustomization>; llm: ResolvedLlm }> {
  const customization = validateTaskCustomization(await config.customizeTask(task));
  const provider = customization.llm.provider;
  if (provider === "amazon-bedrock") {
    return { customization, llm: { provider, model: customization.llm.model, apiKey: null } };
  }
  const definition = config.llmProviders[provider];
  if (!definition) {
    const fix = `Add llmProviders.${provider}: { getApiKey: () => ... } to the Bear Metal configuration module.`;
    throw new Error(`customizeTask selected unconfigured LLM provider "${provider}". ${fix}`);
  }
  const apiKey = await resolveSecret(definition.getApiKey, `config.llmProviders.${provider}.getApiKey result`);
  return { customization, llm: { provider, model: customization.llm.model, apiKey } };
}

function normalizeStatus(value: string): TaskStatusCategory {
  switch (value) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
    case "started":
    case "completed":
    case "canceled":
      return value;
    default:
      throw new Error(`Unsupported task status category: ${value}`);
  }
}
function normalizePriority(value: number): TaskPriority {
  switch (value) {
    case 0: return "none";
    case 1: return "urgent";
    case 2: return "high";
    case 3: return "medium";
    case 4: return "low";
    default: throw new Error(`Unsupported task priority: ${value}`);
  }
}
function normalizePullRequest(ref: PullRequestRef, context: PullRequestContext): TaskPullRequest {
  const raw = context.pullRequest as Record<string, any>;
  const comments = context.issueComments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    author: comment.author,
    url: null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  }));
  return {
    owner: ref.owner, repository: ref.repo, number: ref.number,
    title: typeof raw.title === "string" ? raw.title : `Pull request #${ref.number}`,
    url: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    state: typeof raw.state === "string" ? raw.state : "open",
    draft: raw.draft === true, merged: raw.merged === true,
    headRef: typeof raw.head?.ref === "string" ? raw.head.ref : "",
    headSha: context.headSha,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : null,
    mergedAt: typeof raw.merged_at === "string" ? raw.merged_at : null,
    closedAt: typeof raw.closed_at === "string" ? raw.closed_at : null,
    mergeable: context.mergeable,
    failedChecks: [
      ...context.failedCheckRuns.map((run) => {
      const check = run.checkRun as Record<string, any>;
      return { name: String(check.name ?? "check"), status: String(check.status ?? "unknown"), conclusion: typeof check.conclusion === "string" ? check.conclusion : null, url: typeof check.html_url === "string" ? check.html_url : null };
      }),
      ...context.failedStatuses.map((entry) => {
        const status = entry.status as Record<string, any>;
        return { name: String(status.context ?? "commit status"), status: String(status.state ?? "failure"), conclusion: typeof status.state === "string" ? status.state : null, url: typeof status.target_url === "string" ? status.target_url : null };
      }),
    ],
    comments,
    reviewThreads: context.reviewThreads.map((thread) => ({ id: thread.id, resolved: thread.isResolved, path: thread.path, line: thread.line, comments: thread.comments.map((comment) => ({ id: comment.id, body: comment.body, author: comment.author, url: comment.url, createdAt: comment.createdAt, updatedAt: comment.updatedAt })) })),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
