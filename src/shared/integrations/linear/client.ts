import { type Comment, type Issue, LinearClient } from "@linear/sdk";

import type { CommentCapable, Integration } from "../base.js";
import type { FindTicketsOptions, LinearTicketContext, Ticket, TicketComment } from "./types.js";

export interface LinearIntegrationOptions {
  token: string;
}

/** Linear integration. Extend with more capabilities (find, label, ...) as needed. */
export class LinearIntegration implements Integration, CommentCapable<string> {
  readonly name = "linear";
  private readonly client: LinearClient;

  constructor(options: LinearIntegrationOptions) {
    this.client = new LinearClient({ apiKey: options.token });
  }

  async findTicketsByLabel(label: string, options: FindTicketsOptions = {}): Promise<Ticket[]> {
    const filter =
      options.status !== undefined
        ? {
            labels: { some: { name: { eq: label } } },
            state: { name: { eq: options.status } },
          }
        : { labels: { some: { name: { eq: label } } } };
    const page = await this.client.issues({ filter });
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

  async commentAndAssignToCreator(ticketId: string, body: string): Promise<void> {
    const issue = await this.client.issue(ticketId);
    const creatorId = issue.creatorId;
    if (!creatorId) {
      throw new Error(`Linear issue ${issue.identifier} has no creator to assign back to`);
    }

    await this.client.createComment({ issueId: ticketId, body });
    await issue.update({ assigneeId: creatorId });
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
