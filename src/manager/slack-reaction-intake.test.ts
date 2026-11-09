import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../shared/logger.js";
import { createReactionIntake, reactionIssueId, ticketTitle } from "./slack-reaction-intake.js";

const reaction = { workspaceId: "T1", channelId: "C1", messageTs: "100.2", userId: "UMEMBER" };

function setup(existing: { id: string; url: string } | null = null) {
  const linear = {
    findIssue: vi.fn(async () => existing),
    createSlackCodingTicket: vi.fn(async (input: { id?: string }) => ({ id: input.id!, url: "https://linear.example/DEN-1", identifier: "DEN-1" })),
    findUserIdByEmail: vi.fn(async () => "linear-member"),
    addLabelsByName: vi.fn(async () => []),
    delegateSlackCodingTicket: vi.fn(async () => {}),
  };
  const api = {
    readMessageThread: vi.fn(async () => ({
      threadTs: "100.0",
      permalink: "https://slack.example/p1",
      messages: [
        { ts: "100.0", user: "U0", text: "The export button is broken" },
        { ts: "100.2", user: "U1", text: "Can we fix <https://acme.dev/export|the export page> today?\nDetails below", fileCount: 1 },
      ],
    })),
    getUserEmail: vi.fn(async () => "member@example.com"),
  };
  const customizeTask = vi.fn(async () => ({ llm: { provider: "anthropic", model: "m" }, buildWorkspace: async () => {}, ticketLabels: ["signal:slack"] }));
  const intake = createReactionIntake({
    trigger: { emoji: "bear_paw_seen", linearTeamId: "team-1", linearProjectId: "project-1" },
    api, linear, config: { customizeTask } as never, logger: createLogger({ name: "test", level: "silent" }),
  });
  return { intake, linear, api, customizeTask };
}

describe("Slack reaction intake", () => {
  it("creates a contextual ticket assigned to the reacting user and delegates it without touching Slack", async () => {
    const { intake, linear, api } = setup();
    await intake(reaction);
    expect(api.getUserEmail).toHaveBeenCalledWith("UMEMBER");
    expect(linear.findUserIdByEmail).toHaveBeenCalledWith("member@example.com");
    const created = linear.createSlackCodingTicket.mock.calls[0]![0] as Record<string, string>;
    expect(created).toMatchObject({ id: reactionIssueId(reaction), teamId: "team-1", projectId: "project-1", assigneeId: "linear-member", title: "[Slack] Can we fix the export page today?" });
    expect(created.description).toContain("https://slack.example/p1");
    expect(created.description).toContain("The export button is broken");
    expect(created.description).toContain("**(flagged)** [1 file(s)]");
    expect(created.description).toContain("Do not post to Slack");
    expect(linear.addLabelsByName).toHaveBeenCalledWith(reactionIssueId(reaction), ["signal:slack"]);
    expect(linear.delegateSlackCodingTicket).toHaveBeenCalledWith(reactionIssueId(reaction));
  });

  it("reuses the existing ticket for a message that was already flagged", async () => {
    const { intake, linear, api } = setup({ id: reactionIssueId(reaction), url: "https://linear.example/DEN-1" });
    await intake({ ...reaction, userId: "UOTHER" });
    expect(api.readMessageThread).not.toHaveBeenCalled();
    expect(linear.createSlackCodingTicket).not.toHaveBeenCalled();
    expect(linear.delegateSlackCodingTicket).toHaveBeenCalledWith(reactionIssueId(reaction));
  });

  it("does not create a ticket when the reacting user has no Linear account", async () => {
    const { intake, linear } = setup();
    linear.findUserIdByEmail.mockRejectedValueOnce(new Error("Expected one Linear user"));
    await expect(intake(reaction)).rejects.toThrow("Expected one Linear user");
    expect(linear.createSlackCodingTicket).not.toHaveBeenCalled();
    expect(linear.delegateSlackCodingTicket).not.toHaveBeenCalled();
  });

  it("derives a stable UUID v4 per message", () => {
    const id = reactionIssueId(reaction);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(reactionIssueId(reaction)).toBe(id);
    expect(reactionIssueId({ ...reaction, messageTs: "100.3" })).not.toBe(id);
  });

  it("builds a readable title from the first non-empty line", () => {
    expect(ticketTitle("\n<@U1> please <https://x.dev|update the docs>")).toBe("[Slack] @U1 please update the docs");
    expect(ticketTitle("<<b>script>alert(1)")).toBe("[Slack] bscriptalert(1)");
    expect(ticketTitle("")).toBe("[Slack] Flagged request");
    expect(ticketTitle("x".repeat(200)).length).toBe("[Slack] ".length + 80);
  });
});
