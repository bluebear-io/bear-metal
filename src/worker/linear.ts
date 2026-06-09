import type { JsonValue, TicketContext } from "./types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export class LinearClient {
  constructor(private readonly apiKey: string) {}

  async getTicketContext(ticketId: string): Promise<TicketContext> {
    const issue = await this.query<{ issue: JsonValue }>(ISSUE_QUERY, { id: ticketId });
    if (!issue.issue) {
      throw new Error(`Linear issue not found: ${ticketId}`);
    }

    const comments: JsonValue[] = [];
    let after: string | null = null;
    do {
      const page: CommentsPage = await this.query<CommentsPage>(COMMENTS_QUERY, { id: ticketId, after });
      comments.push(...page.issue.comments.nodes);
      after = page.issue.comments.pageInfo.hasNextPage ? page.issue.comments.pageInfo.endCursor : null;
    } while (after);

    return { issue: issue.issue, comments };
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.query(CREATE_COMMENT_MUTATION, { issueId, body });
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors?.length) {
      throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new Error("Linear GraphQL response did not include data");
    }
    return payload.data;
  }
}

type CommentsPage = {
  issue: {
    comments: {
      nodes: JsonValue[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
};

const ISSUE_QUERY = `
  query BearMetalIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      branchName
      createdAt
      updatedAt
      priority
      estimate
      dueDate
      team { id key name }
      state { id name type }
      assignee { id name email }
      creator { id name email }
      project { id name }
      cycle { id number name }
      parent { id identifier title }
      labels(first: 250) { nodes { id name } }
      attachments(first: 100) { nodes { id title url } }
    }
  }
`;

const COMMENTS_QUERY = `
  query BearMetalIssueComments($id: String!, $after: String) {
    issue(id: $id) {
      comments(first: 100, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user { id name email }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation BearMetalCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;
