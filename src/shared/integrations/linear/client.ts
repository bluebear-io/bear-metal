import { AuthenticationLinearError, type Issue, LinearClient } from "@linear/sdk";

import type { CommentCapable, Integration } from "../base.js";
import type { TokenProvider } from "./token.js";
import type { LinearTicketContext, Ticket, TicketAttachment } from "./types.js";

export interface LinearIntegrationOptions {
  tokenProvider: TokenProvider;
}

interface GetTicketResponse {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    branchName: string;
    priority: number;
    assignee: { id: string } | null;
    delegate: { id: string } | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    canceledAt: string | null;
    state: { name: string; type: string } | null;
    labels: { nodes: Array<{ name: string }> };
    team: { key: string } | null;
  } | null;
}

interface RawPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  user: { id: string; name: string; email: string } | null;
}

interface RawAttachment {
  id: string;
  title: string;
  url: string;
}

interface RawRelation {
  id: string;
  type: string;
  relatedIssue: { identifier: string } | null;
}

interface GetTicketContextResponse {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    url: string;
    branchName: string;
    priority: number | null;
    assignee: { id: string; name: string; email: string | null } | null;
    delegate: { id: string } | null;
    project: { id: string; name: string } | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    canceledAt: string | null;
    state: { name: string; type: string } | null;
    labels: { nodes: Array<{ name: string }> };
    team: { key: string } | null;
    relations: { nodes: RawRelation[] };
    inverseRelations: { nodes: RawRelation[] };
    comments: RawPage<RawComment>;
    attachments: RawPage<RawAttachment>;
  } | null;
}

interface GetCommentsResponse {
  issue: { comments: RawPage<RawComment> } | null;
}

interface GetAttachmentsResponse {
  issue: { attachments: RawPage<RawAttachment> } | null;
}

const GET_TICKET_QUERY = `
  query GetTicket($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      branchName
      priority
      assignee { id }
      delegate { id }
      createdAt
      updatedAt
      completedAt
      canceledAt
      state { name type }
      labels { nodes { name } }
      team { key }
    }
  }
`;

const GET_TICKET_CONTEXT_QUERY = `
  query GetTicketContext($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      branchName
      priority
      assignee { id name email }
      delegate { id }
      project { id name }
      createdAt
      updatedAt
      completedAt
      canceledAt
      state { name type }
      labels { nodes { name } }
      team { key }
      relations(first: 100) {
        nodes { id type relatedIssue { identifier } }
      }
      inverseRelations(first: 100) {
        nodes { id type relatedIssue { identifier } }
      }
      comments(first: 100) {
        nodes { id body createdAt updatedAt url user { id name email } }
        pageInfo { hasNextPage endCursor }
      }
      attachments(first: 100) {
        nodes { id title url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const GET_TICKET_COMMENTS_QUERY = `
  query GetTicketComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: 100, after: $after) {
        nodes { id body createdAt updatedAt url user { id name email } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const GET_TICKET_ATTACHMENTS_QUERY = `
  query GetTicketAttachments($id: String!, $after: String) {
    issue(id: $id) {
      attachments(first: 100, after: $after) {
        nodes { id title url }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** Workflow-state types that mean a ticket needs no further work; never admitted. */
const TERMINAL_STATE_TYPES = ["completed", "canceled"];

/**
 * States excluded by name because their *type* doesn't mark them done. "Merged" is a `started`-type
 * state here (same family as In Progress / In Review, which are wanted), so type filtering misses it.
 */
const EXCLUDED_STATE_NAMES = ["Merged"];

export class LinearIntegration implements Integration, CommentCapable<string> {
  readonly name = "linear";
  private readonly tokenProvider: TokenProvider;
  private client: LinearClient | undefined;
  private clientToken: string | undefined;
  private cachedAgentId: string | undefined;

  constructor(options: LinearIntegrationOptions) {
    this.tokenProvider = options.tokenProvider;
  }

  async getAgentId(): Promise<string> {
    if (!this.cachedAgentId) {
      this.cachedAgentId = await this.withClient(async (client) => (await client.viewer).id);
    }
    return this.cachedAgentId;
  }

  async getAccessToken(): Promise<string> {
    return this.tokenProvider.getToken();
  }

  /**
   * Non-terminal issues delegated to the agent. Linear assigns work to an agent via *delegation*
   * (the human stays the assignee), so the manager discovers its tickets through `delegatedIssues`,
   * not the `assignee` filter — `IssueFilter` has no `delegate` field to filter on directly.
   * Completed/canceled tickets are excluded (by type), as is "Merged" (by name), so the agent works
   * everything still open, in any non-done state (Triage/Backlog/Todo/In Progress/In Review).
   */
  async findDelegatedTickets(agentId: string): Promise<Ticket[]> {
    return this.withClient(async (client) => {
      const user = await client.user(agentId);
      const page = await user.delegatedIssues({
        filter: { state: { type: { nin: TERMINAL_STATE_TYPES }, name: { nin: EXCLUDED_STATE_NAMES } } },
      });
      return Promise.all(page.nodes.map((issue) => this.toTicket(issue)));
    });
  }

  async findAllDelegatedTickets(agentId: string): Promise<Ticket[]> {
    return this.withClient(async (client) => {
      const user = await client.user(agentId);
      const issues: Issue[] = [];
      let after: string | undefined;
      do {
        const page = await user.delegatedIssues({ first: 100, after });
        issues.push(...page.nodes);
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
      } while (after !== undefined);
      return Promise.all(issues.map((issue) => this.toTicket(issue)));
    });
  }

  async getTicket(id: string): Promise<Ticket> {
    return this.withClient(async (client) => {
      const { data } = await client.client.rawRequest<GetTicketResponse, { id: string }>(GET_TICKET_QUERY, { id });
      if (!data) {
        throw new Error(`Linear returned no data for issue ${id}`);
      }
      if (!data.issue) {
        throw new Error(`Linear issue ${id} not found`);
      }
      const issue = data.issue;
      if (!issue.state) {
        throw new Error(`Linear issue ${issue.identifier} has no workflow state`);
      }
      if (!issue.team) {
        throw new Error(`Linear issue ${issue.identifier} has no team`);
      }
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        branchName: issue.branchName,
        status: issue.state,
        priority: issue.priority ?? 0,
        labels: issue.labels.nodes.map((label) => label.name),
        teamKey: issue.team.key,
        assignee: issue.assignee,
        delegate: issue.delegate,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        completedAt: issue.completedAt,
        canceledAt: issue.canceledAt,
      };
    });
  }

  async getUserEmail(userId: string): Promise<string | null> {
    return this.withClient(async (client) => {
      const user = await client.user(userId);
      return user.email ?? null;
    });
  }

  async getTicketAssignees(ticketIds: string[]): Promise<Map<string, string | null>> {
    if (ticketIds.length === 0) return new Map();

    return this.withClient(async (client) => {
      const issuesConn = await client.issues({
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
          const user = await client.user(userId);
          userNames.set(userId, user.email ?? user.displayName ?? user.name ?? userId);
        }),
      );

      const result = new Map<string, string | null>();
      for (const ticketId of ticketIds) {
        const assigneeId = ticketAssignee.get(ticketId);
        result.set(ticketId, assigneeId ? (userNames.get(assigneeId) ?? null) : null);
      }
      return result;
    });
  }

  async getTicketContext(id: string): Promise<LinearTicketContext> {
    return this.withClient(async (client) => {
      const { data } = await client.client.rawRequest<GetTicketContextResponse, { id: string }>(GET_TICKET_CONTEXT_QUERY, { id });
      const issue = this.requireRawIssue(data, id);
      const comments = [...issue.comments.nodes];
      let commentsPage = issue.comments;
      while (commentsPage.pageInfo.hasNextPage) {
        const after = this.requireNextCursor(commentsPage.pageInfo.endCursor, id, "comments");
        const response = await client.client.rawRequest<GetCommentsResponse, { id: string; after: string }>(GET_TICKET_COMMENTS_QUERY, { id, after });
        commentsPage = this.requireRawIssue(response.data, id).comments;
        comments.push(...commentsPage.nodes);
      }
      const attachments = [...issue.attachments.nodes];
      let attachmentsPage = issue.attachments;
      while (attachmentsPage.pageInfo.hasNextPage) {
        const after = this.requireNextCursor(attachmentsPage.pageInfo.endCursor, id, "attachments");
        const response = await client.client.rawRequest<GetAttachmentsResponse, { id: string; after: string }>(GET_TICKET_ATTACHMENTS_QUERY, { id, after });
        attachmentsPage = this.requireRawIssue(response.data, id).attachments;
        attachments.push(...attachmentsPage.nodes);
      }
      return {
        issue: this.toContextTicket(issue),
        comments,
        attachments,
      };
    });
  }

  async getTicketAttachments(id: string): Promise<TicketAttachment[]> {
    return this.withClient(async (client) => {
      const attachments: TicketAttachment[] = [];
      let after: string | undefined;
      do {
        const { data } = await client.client.rawRequest<GetAttachmentsResponse, { id: string; after?: string }>(GET_TICKET_ATTACHMENTS_QUERY, { id, after });
        const page = this.requireRawIssue(data, id).attachments;
        attachments.push(
          ...page.nodes
            .filter(
              (attachment) => URL.canParse(attachment.url) && new URL(attachment.url).hostname === "uploads.linear.app",
            )
            .map((attachment) => ({ id: attachment.id, title: attachment.title, url: attachment.url })),
        );
        after = page.pageInfo.hasNextPage ? this.requireNextCursor(page.pageInfo.endCursor, id, "attachments") : undefined;
      } while (after !== undefined);
      return attachments;
    });
  }

  async leaveComment(ticketId: string, body: string): Promise<void> {
    await this.withClient((client) => client.createComment({ issueId: ticketId, body }));
  }

  async moveTicketToInProgress(ticketId: string): Promise<void> {
    await this.moveTicketToState(ticketId, "In Progress");
  }

  async moveTicketToInReview(ticketId: string): Promise<void> {
    await this.moveTicketToState(ticketId, "In Review");
  }

  private async moveTicketToState(ticketId: string, stateName: string): Promise<void> {
    await this.withClient(async (client) => {
      const issue = await client.issue(ticketId);
      const team = await issue.team;
      if (!team) {
        throw new Error(`Linear issue ${issue.identifier} has no team`);
      }

      const states = await client.workflowStates({
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
    });
  }

  async commentAndHandBack(ticketId: string, body: string): Promise<void> {
    await this.leaveComment(ticketId, body);
    await this.handBack(ticketId);
  }

  async handBack(ticketId: string): Promise<void> {
    await this.withClient(async (client) => {
      const issue = await client.issue(ticketId);
      await issue.update({ delegateId: null });
    });
  }

  async getPullRequestRefs(ticketId: string): Promise<{ owner: string; repo: string; number: number }[]> {
    return this.withClient(async (client) => {
      const issue = await client.issue(ticketId);
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
    });
  }

  private async withClient<T>(fn: (client: LinearClient) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getClient());
    } catch (error) {
      if (!(error instanceof AuthenticationLinearError)) {
        throw error;
      }
      this.tokenProvider.invalidate();
      // A revoked token may be replaced by one for a different actor (e.g. after a scope change),
      // so drop the cached agent id and let it re-resolve against the fresh token.
      this.cachedAgentId = undefined;
      return fn(await this.getClient());
    }
  }

  private async getClient(): Promise<LinearClient> {
    const token = await this.tokenProvider.getToken();
    if (!this.client || token !== this.clientToken) {
      this.client = new LinearClient({ accessToken: token });
      this.clientToken = token;
    }
    return this.client;
  }

  private async toTicket(issue: Issue): Promise<Ticket> {
    const [state, labels, team, assignee, project, relationsPage, inverseRelationsPage] = await Promise.all([
      issue.state,
      issue.labels(),
      issue.team,
      issue.assignee,
      issue.project,
      issue.relations({ first: 100 }),
      issue.inverseRelations({ first: 100 }),
    ]);
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
      assignee: assignee ? { id: assignee.id, name: assignee.name, email: assignee.email ?? null } : null,
      project: project ? { id: project.id, name: project.name } : null,
      relations: await Promise.all([...relationsPage.nodes, ...inverseRelationsPage.nodes].map(async (relation) => {
        const related = await relation.relatedIssue;
        if (!related) throw new Error(`Linear relation ${relation.id} has no related issue`);
        return { type: relation.type, taskIdentifier: related.identifier };
      })),
      delegate: issue.delegateId ? { id: issue.delegateId } : null,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      completedAt: issue.completedAt?.toISOString() ?? null,
      canceledAt: issue.canceledAt?.toISOString() ?? null,
    };
  }

  private toContextTicket(issue: NonNullable<GetTicketContextResponse["issue"]>): Ticket {
    if (!issue.state) throw new Error(`Linear issue ${issue.identifier} has no workflow state`);
    if (!issue.team) throw new Error(`Linear issue ${issue.identifier} has no team`);
    const relations = [...issue.relations.nodes, ...issue.inverseRelations.nodes].map((relation) => {
      if (!relation.relatedIssue) throw new Error(`Linear relation ${relation.id} has no related issue`);
      return { type: relation.type, taskIdentifier: relation.relatedIssue.identifier };
    });
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      branchName: issue.branchName,
      status: issue.state,
      priority: issue.priority ?? 0,
      labels: issue.labels.nodes.map((label) => label.name),
      teamKey: issue.team.key,
      assignee: issue.assignee,
      project: issue.project,
      relations,
      delegate: issue.delegate,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      completedAt: issue.completedAt,
      canceledAt: issue.canceledAt,
    };
  }

  private requireRawIssue<T extends { issue: unknown }>(data: T | undefined, id: string): NonNullable<T["issue"]> {
    if (!data) throw new Error(`Linear returned no data for issue ${id}`);
    if (!data.issue) throw new Error(`Linear issue ${id} not found`);
    return data.issue as NonNullable<T["issue"]>;
  }

  private requireNextCursor(cursor: string | null, id: string, connection: string): string {
    if (!cursor) throw new Error(`Linear issue ${id} ${connection} page has no end cursor`);
    return cursor;
  }
}
