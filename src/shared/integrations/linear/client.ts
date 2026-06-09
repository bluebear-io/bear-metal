import { type Issue, LinearClient } from "@linear/sdk";

import type { CommentCapable, Integration } from "../base.js";
import type { FindTicketsOptions, Ticket } from "./types.js";

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

  async leaveComment(ticketId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId: ticketId, body });
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
}
