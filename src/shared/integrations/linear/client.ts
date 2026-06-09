import { type Comment, type Issue, LinearClient } from "@linear/sdk";

import type { CommentCapable, Integration } from "../base.js";
import type { LinearTicketContext, Ticket, TicketComment } from "./types.js";

export interface LinearIntegrationOptions {
  token: string;
}

/** Workflow-state types that mean a ticket needs no further work; never admitted. */
const TERMINAL_STATE_TYPES = ["completed", "canceled"];

/** Linear integration. Extend with more capabilities (find, label, ...) as needed. */
export class LinearIntegration implements Integration, CommentCapable<string> {
  readonly name = "linear";
  private readonly client: LinearClient;

  constructor(options: LinearIntegrationOptions) {
    this.client = new LinearClient({ apiKey: options.token });
  }

  /**
   * Non-terminal issues delegated to the agent. Linear assigns work to an agent via *delegation*
   * (the human stays the assignee), so the manager discovers its tickets through `delegatedIssues`,
   * not the `assignee` filter — `IssueFilter` has no `delegate` field to filter on directly.
   * Completed/canceled tickets are excluded so the agent works everything still open, in any
   * non-done state (Triage/Backlog/Todo/In Progress).
   */
  async findDelegatedTickets(agentId: string): Promise<Ticket[]> {
    const user = await this.client.user(agentId);
    const page = await user.delegatedIssues({
      filter: { state: { type: { nin: TERMINAL_STATE_TYPES } } },
    });
    return Promise.all(page.nodes.map((issue) => this.toTicket(issue)));
  }

  async getTicket(id: string): Promise<Ticket> {
    const issue = await this.client.issue(id);
    return this.toTicket(issue);
  }

  async getTicketContext(id: string): Promise<LinearTicketContext> {
    const issue = await this.client.issue(id);
    const [ticket, comments] = await Promise.all([this.toTicket(issue), this.getComments(issue)]);
    return { issue: ticket, comments };
  }

  async leaveComment(ticketId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId: ticketId, body });
  }

  /**
   * Hand the ticket back to its human owner: comment, then relinquish the agent's delegation.
   * Clearing `delegateId` is what un-parks the manager's hold — the human re-delegates to resume.
   */
  async commentAndHandBack(ticketId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId: ticketId, body });
    const issue = await this.client.issue(ticketId);
    await issue.update({ delegateId: null });
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
    const state = await issue.state;
    if (!state) {
      throw new Error(`Linear issue ${issue.identifier} has no workflow state`);
    }
    const labels = await issue.labels();
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      url: issue.url,
      branchName: issue.branchName,
      status: { name: state.name, type: state.type },
      labels: labels.nodes.map((node) => node.name),
      assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
      delegate: issue.delegateId ? { id: issue.delegateId } : null,
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
