import { type Comment, type Issue, LinearClient } from "@linear/sdk";

import type { CommentCapable, Integration } from "../base.js";
import type { LinearTicketContext, Ticket, TicketComment } from "./types.js";

export interface LinearIntegrationOptions {
  token: string;
}

/** Workflow-state types that mean a ticket needs no further work; never admitted. */
const TERMINAL_STATE_TYPES = ["completed", "canceled"];

/**
 * States excluded by name because their *type* doesn't mark them done. "Merged" is a `started`-type
 * state here (same family as In Progress / In Review, which are wanted), so type filtering misses it.
 */
const EXCLUDED_STATE_NAMES = ["Merged"];

export class LinearIntegration implements Integration, CommentCapable<string> {
  readonly name = "linear";
  private readonly client: LinearClient;
  private cachedAgentId: string | undefined;

  constructor(options: LinearIntegrationOptions) {
    this.client = new LinearClient({ apiKey: options.token });
  }

  async getAgentId(): Promise<string> {
    if (!this.cachedAgentId) {
      const viewer = await this.client.viewer;
      this.cachedAgentId = viewer.id;
    }
    return this.cachedAgentId;
  }

  /**
   * Non-terminal issues delegated to the agent. Linear assigns work to an agent via *delegation*
   * (the human stays the assignee), so the manager discovers its tickets through `delegatedIssues`,
   * not the `assignee` filter — `IssueFilter` has no `delegate` field to filter on directly.
   * Completed/canceled tickets are excluded (by type), as is "Merged" (by name), so the agent works
   * everything still open, in any non-done state (Triage/Backlog/Todo/In Progress/In Review).
   */
  async findDelegatedTickets(agentId: string): Promise<Ticket[]> {
    const user = await this.client.user(agentId);
    const page = await user.delegatedIssues({
      filter: { state: { type: { nin: TERMINAL_STATE_TYPES }, name: { nin: EXCLUDED_STATE_NAMES } } },
    });
    return Promise.all(page.nodes.map((issue) => this.toTicket(issue)));
  }

  async findAllDelegatedTickets(agentId: string): Promise<Ticket[]> {
    const user = await this.client.user(agentId);
    const issues: Issue[] = [];
    let after: string | undefined;
    do {
      const page = await user.delegatedIssues({ first: 100, after });
      issues.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
    } while (after !== undefined);
    return Promise.all(issues.map((issue) => this.toTicket(issue)));
  }

  async getTicket(id: string): Promise<Ticket> {
    const issue = await this.client.issue(id);
    return this.toTicket(issue);
  }

  async getUserEmail(userId: string): Promise<string | null> {
    const user = await this.client.user(userId);
    return user.email ?? null;
  }

  async getTicketAssignees(ticketIds: string[]): Promise<Map<string, string | null>> {
    if (ticketIds.length === 0) return new Map();

    const issuesConn = await this.client.issues({
      filter: { id: { in: ticketIds } },
      first: ticketIds.length,
    });

    const ticketAssignee = new Map<string, string>(); // ticket_id → assignee user id
    const uniqueAssigneeIds = new Set<string>();
    for (const issue of issuesConn.nodes) {
      if (issue.assigneeId) {
        ticketAssignee.set(issue.id, issue.assigneeId);
        uniqueAssigneeIds.add(issue.assigneeId);
      }
    }

    const userNames = new Map<string, string>(); // user_id → display name
    await Promise.all(
      [...uniqueAssigneeIds].map(async (userId) => {
        const user = await this.client.user(userId);
        userNames.set(userId, user.email ?? user.displayName ?? user.name ?? userId);
      }),
    );

    const result = new Map<string, string | null>();
    for (const ticketId of ticketIds) {
      const assigneeId = ticketAssignee.get(ticketId);
      result.set(ticketId, assigneeId ? (userNames.get(assigneeId) ?? null) : null);
    }
    return result;
  }

  async getTicketContext(id: string): Promise<LinearTicketContext> {
    const issue = await this.client.issue(id);
    const [ticket, comments] = await Promise.all([this.toTicket(issue), this.getComments(issue)]);
    return { issue: ticket, comments };
  }

  async leaveComment(ticketId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId: ticketId, body });
  }

  async moveTicketToInProgress(ticketId: string): Promise<void> {
    await this.moveTicketToState(ticketId, "In Progress");
  }

  async moveTicketToInReview(ticketId: string): Promise<void> {
    await this.moveTicketToState(ticketId, "In Review");
  }

  private async moveTicketToState(ticketId: string, stateName: string): Promise<void> {
    const issue = await this.client.issue(ticketId);
    const team = await issue.team;
    if (!team) {
      throw new Error(`Linear issue ${issue.identifier} has no team`);
    }

    const states = await this.client.workflowStates({
      filter: {
        name: { eq: stateName },
        team: { id: { eq: team.id } },
      },
      first: 10,
    });
    const state = states.nodes.find((candidate) => candidate.name === stateName && candidate.teamId === team.id);
    if (!state) {
      throw new Error(`Linear team ${team.name} has no ${stateName} workflow state`);
    }

    await issue.update({ stateId: state.id });
  }

  async commentAndHandBack(ticketId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId: ticketId, body });
    await this.handBack(ticketId);
  }

  async handBack(ticketId: string): Promise<void> {
    const issue = await this.client.issue(ticketId);
    await issue.update({ delegateId: null });
  }

  async getPullRequestRefs(ticketId: string): Promise<{ owner: string; repo: string; number: number }[]> {
    const issue = await this.client.issue(ticketId);
    const attachments = await issue.attachments();
    const refs: { owner: string; repo: string; number: number }[] = [];
    for (const attachment of attachments.nodes) {
      if (attachment.sourceType !== "github") continue;
      const match = attachment.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
      if (!match) continue;
      const meta = attachment.metadata as Record<string, unknown> | null;
      const state = (meta?.state ?? meta?.status) as string | undefined;
      if (state === "closed" || state === "merged") continue;
      refs.push({ owner: match[1]!, repo: match[2]!, number: parseInt(match[3]!, 10) });
    }
    return refs;
  }

  private async getComments(issue: Issue): Promise<TicketComment[]> {
    const comments: TicketComment[] = [];
    let after: string | undefined;
    do {
      const page = await issue.comments({ first: 100, after });
      comments.push(...(await Promise.all(page.nodes.map((comment) => this.toComment(comment)))));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
    } while (after !== undefined);
    return comments;
  }

  private async toTicket(issue: Issue): Promise<Ticket> {
    const [state, labels, team] = await Promise.all([issue.state, issue.labels(), issue.team]);
    if (!state) {
      throw new Error(`Linear issue ${issue.identifier} has no workflow state`);
    }
    if (!team) {
      throw new Error(`Linear issue ${issue.identifier} has no team`);
    }
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      url: issue.url,
      branchName: issue.branchName,
      status: { name: state.name, type: state.type },
      priority: issue.priority ?? 0,
      labels: labels.nodes.map((node) => node.name),
      teamKey: team.key,
      assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
      delegate: issue.delegateId ? { id: issue.delegateId } : null,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      completedAt: issue.completedAt?.toISOString() ?? null,
      canceledAt: issue.canceledAt?.toISOString() ?? null,
    };
  }

  private async toComment(comment: Comment): Promise<TicketComment> {
    const user = comment.user ? await comment.user : null;
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      url: comment.url,
      quotedText: comment.quotedText ?? null,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
    };
  }
}
