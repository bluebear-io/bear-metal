import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BearMetalConfig, SlackChannelIntakePolicy } from "../customization/types.js";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import type { runSlackAgent } from "../worker/slack-agent.js";
import { SLACK_INTAKE_REACTION_MAX_ATTEMPTS, SlackIntake } from "./slack-intake.js";
import { type SlackIntakeChannel, type SlackThreadMessage, type SlackIntakeUser } from "./slack-thread-api.js";

const RETRY_BASE = 5 * 60 * 1000;
const DUE = "9999-12-31T00:00:00.000Z";
const NOW = Date.UTC(2026, 10, 5, 12);

type AgentInput = Parameters<typeof runSlackAgent>[0];

function message(ts: string, user: string, text: string, extra: Partial<SlackThreadMessage> = {}): SlackThreadMessage {
  return { ts, user, text, fileCount: 0, ...extra };
}

class FakeSlack {
  channels: SlackIntakeChannel[] = [
    { id: "CACME", name: "support-acme", isMember: true },
    { id: "CGLOBEX", name: "support-globex", isMember: false },
    { id: "CENG", name: "engineering", isMember: true },
  ];
  users: Record<string, SlackIntakeUser> = {
    UMEMBER: { id: "UMEMBER", name: "Dana Member", teamId: "T1", isBot: false, deleted: false, guest: false },
    UGUEST: { id: "UGUEST", name: "Gus Guest", teamId: "T1", isBot: false, deleted: false, guest: true },
    UEXTERNAL: { id: "UEXTERNAL", name: "Casey External", teamId: "TEXTERNAL", isBot: false, deleted: false, guest: false },
  };
  threads: Record<string, SlackThreadMessage[]> = {};

  listChannels = async () => this.channels;
  getChannel = async (id: string) => {
    const channel = this.channels.find((candidate) => candidate.id === id);
    if (!channel) throw new Error(`unknown channel ${id}`);
    return channel;
  };
  getUser = async (id: string) => {
    const user = this.users[id];
    if (!user) throw new Error(`unknown user ${id}`);
    return user;
  };
  readMessageThread = async (channelId: string, messageTs: string) => {
    for (const [key, messages] of Object.entries(this.threads)) {
      if (key.startsWith(`${channelId}/`) && messages.some((candidate) => candidate.ts === messageTs)) {
        return { threadTs: key.slice(channelId.length + 1), messages };
      }
    }
    throw new Error(`Slack message ${channelId}/${messageTs} was not found`);
  };
  getPermalink = async (channelId: string, messageTs: string) => `https://example.slack.com/archives/${channelId}/p${messageTs.replace(".", "")}`;
}

class FakeLinear {
  created: Array<{ id?: string; teamId: string; title: string; description: string; assigneeId?: string }> = [];
  delegated: string[] = [];
  labeled: Array<{ ticketId: string; labels: readonly string[] }> = [];
  createSlackCodingTicket = vi.fn(async (input: { id?: string; teamId: string; title: string; description: string; assigneeId?: string }) => {
    this.created.push(input);
    const n = this.created.length;
    return { id: input.id!, identifier: `DEN-${n}`, url: `https://linear.app/issue/DEN-${n}` };
  });
  getTicket = vi.fn(async (id: string, _allowMissing?: true): Promise<any> => {
    const index = this.created.findIndex((ticket) => ticket.id === id);
    return index < 0 ? null : { id, identifier: `DEN-${index + 1}`, url: `https://linear.app/issue/DEN-${index + 1}` };
  });
  delegateSlackCodingTicket = vi.fn(async (id: string) => { this.delegated.push(id); });
  findUserIdByEmail = vi.fn(async (email: string) => {
    if (email !== "owner@example.com") throw new Error(`unexpected owner ${email}`);
    return "linear-owner";
  });
  listSlackTicketDestinations = vi.fn(async () => ({
    teams: [{ id: "team-1", key: "DEN", name: "Engineering" }, { id: "team-2", key: "OPS", name: "Operations" }],
    projects: [{ id: "project-1", name: "Bear Metal", teamIds: ["team-1"] }],
    cycles: [{ id: "cycle-2", name: null, number: 7, teamId: "team-2", startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-11-14T00:00:00.000Z" }],
  }));
  addLabelsByName = vi.fn(async (ticketId: string, labels: readonly string[]) => { this.labeled.push({ ticketId, labels }); return []; });
}

async function call(tools: ToolDefinition[], name: string, params: object) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(name, params as never, undefined, undefined, {} as never);
}

const ticketArgs = (sourceTs: string, title = "Export audit logs as CSV") => ({
  teamId: "team-1", title,
  request: "Please let us export audit logs as CSV.",
  conversationContext: "Acme's compliance team exports logs weekly.",
  expectedOutcome: "Audit logs page offers a CSV download.",
});

describe("Slack channel intake", () => {
  let db: SqlDbClient;
  let slack: FakeSlack;
  let linear: FakeLinear;
  let agent: ReturnType<typeof vi.fn<(input: AgentInput) => Promise<void>>>;
  let intake: SlackIntake;
  let now: number;
  let policy: SlackChannelIntakePolicy;

  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    slack = new FakeSlack();
    linear = new FakeLinear();
    agent = vi.fn(async () => {});
    now = NOW;
    policy = { channelNamePattern: /^support-.+$/, triggerReaction: "ticket", ownerEmail: "owner@example.com",
      isEligibleReactor: (user, workspaceId) => user.teamId === workspaceId && !user.isBot && !user.deleted && !user.guest,
      reactionInstructions: "Track the flagged request." };
    intake = new SlackIntake({
      db, api: slack, linear, github: { getInstallationToken: async () => "token" },
      config: { customizeTask: async () => ({ llm: { provider: "anthropic", model: "m" }, buildWorkspace: async () => {}, ticketLabels: ["signal:slack"] }) } as unknown as BearMetalConfig,
      intake: policy,
      workspaceId: "T1", botUserId: "UBOT", logger: createLogger({ name: "test", level: "silent" }), pollIntervalMs: 60_000,
      now: () => now,
      runAgent: async (input) => {
        await agent(input);
        await input.validateOutcome?.();
      },
    });
  });

  afterEach(async () => {
    await intake.stop();
    await db.close();
  });

  it("polls queued reactions on startup without discovering or scanning channels", async () => {
    const listChannels = vi.spyOn(slack, "listChannels");
    const process = vi.spyOn(intake, "processReactions");
    intake.start();
    await vi.waitFor(() => expect(process).toHaveBeenCalled());
    await intake.stop();
    expect(listChannels).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  const reaction = (overrides: Partial<{ channelId: string; messageTs: string; reactorUserId: string }> = {}) => ({
    workspaceId: "T1", channelId: "CACME", messageTs: "100.2", reactorUserId: "UMEMBER", ...overrides,
  });

  function seedThread() {
    slack.threads["CACME/100.1"] = [
      message("100.1", "UEXTERNAL", "Our auditors want logs."),
      message("100.2", "UEXTERNAL", "Can you add CSV export for audit logs?", { threadTs: "100.1" }),
      message("100.3", "UBOT", "bot noise", { threadTs: "100.1" }),
    ];
  }

  it("creates a contextual ticket assigned to the owner and delegated to Bear Metal for a member's reaction", async () => {
    seedThread();
    agent.mockImplementation(async ({ tools, prompt, task }) => {
      expect(task).toMatchObject({ type: "coordinator", slack: { channelId: "CACME", threadTs: "100.1", sourceTs: "100.2" } });
      expect(prompt).toContain("\"targetMessageTs\":\"100.2\"");
      expect(prompt).not.toContain("bot noise");
      await call(tools, "create_ticket", ticketArgs("100.2"));
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();

    expect(linear.created).toHaveLength(1);
    const created = linear.created[0]!;
    expect(created.assigneeId).toBe("linear-owner");
    expect(created.description).toContain("## Request\nPlease let us export audit logs as CSV.");
    expect(created.description).toContain("## Conversation context\nAcme's compliance team exports logs weekly.");
    expect(created.description).toContain("## Expected outcome\nAudit logs page offers a CSV download.");
    expect(created.description).toContain("- Message: https://example.slack.com/archives/CACME/p1002");
    expect(created.description).toContain("- Channel: #support-acme");
    expect(created.description).toContain("- Requested by: Casey External (Slack user `UEXTERNAL`)");
    expect(created.description).toContain("- Intake: `:ticket:` reaction by Dana Member");
    expect(linear.delegated).toEqual([linear.created[0]!.id]);
    expect(linear.labeled).toEqual([{ ticketId: linear.created[0]!.id, labels: ["signal:slack"] }]);
    expect(await db.hasSlackLinkedTicket(linear.created[0]!.id!)).toBe(true);
    expect(await db.listSlackIntakeThreadTickets("T1", "CACME", "100.1")).toEqual([{ identifier: "DEN-1", url: "https://linear.app/issue/DEN-1" }]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("ignores reactions outside selected channels, in channels the bot has not joined, and from external users, guests, or other workspaces", async () => {
    slack.threads["CENG/200.1"] = [message("200.1", "UMEMBER", "internal")];
    slack.threads["CGLOBEX/300.1"] = [message("300.1", "UEXTERNAL", "Please add SAML")];
    seedThread();
    await db.recordSlackIntakeReaction(reaction({ channelId: "CENG", messageTs: "200.1" }));
    await db.recordSlackIntakeReaction(reaction({ channelId: "CGLOBEX", messageTs: "300.1" }));
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UEXTERNAL" }));
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UGUEST" }));
    await db.recordSlackIntakeReaction({ ...reaction(), workspaceId: "T2" });
    await intake.processReactions();
    expect(agent).not.toHaveBeenCalled();
    expect(linear.created).toEqual([]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("does not create a second ticket for repeated reactions", async () => {
    seedThread();
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    expect(await db.recordSlackIntakeReaction(reaction())).toBe(true);
    expect(await db.recordSlackIntakeReaction(reaction())).toBe(false);
    await intake.processReactions();
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UMEMBER2" }));
    slack.users.UMEMBER2 = { ...slack.users.UMEMBER!, id: "UMEMBER2" };
    await intake.processReactions();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(linear.created).toHaveLength(1);
  });

  it("lets a reaction defer to an existing ticket in the same thread for the same request", async () => {
    seedThread();
    const prior = reaction({ messageTs: "100.1" });
    await db.recordSlackIntakeReaction(prior);
    await db.reserveSlackIntakeIssueId(prior, "100.1");
    await db.completeSlackIntakeTicket(prior, { identifier: "DEN-9", url: "https://linear.app/issue/DEN-9" });
    await db.finishSlackIntakeReaction(prior, "processed", null);
    agent.mockImplementation(async ({ tools, prompt }) => {
      expect(prompt).toContain("\"identifier\":\"DEN-9\"");
      await expect(call(tools, "report_already_tracked", { identifier: "DEN-0", reason: "x" })).rejects.toThrow("No existing thread ticket");
      await call(tools, "report_already_tracked", { identifier: "DEN-9", reason: "Same CSV export request" });
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toEqual([]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("retries a reaction with backoff and fails it visibly after the last attempt", async () => {
    seedThread();
    await db.recordSlackIntakeReaction(reaction());
    for (let attempt = 1; attempt <= SLACK_INTAKE_REACTION_MAX_ATTEMPTS; attempt += 1) {
      await intake.processReactions();
      expect(agent).toHaveBeenCalledTimes(attempt);
      await intake.processReactions();
      expect(agent).toHaveBeenCalledTimes(attempt);
      now += RETRY_BASE * 2 ** (attempt - 1);
    }
    expect(linear.created).toEqual([]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
    expect(await db.recordSlackIntakeReaction(reaction())).toBe(true);
  });

  it("keeps processing other due reactions when recording one reaction's failure fails", async () => {
    seedThread();
    slack.threads["CACME/400.1"] = [message("400.1", "UEXTERNAL", "Please add SSO")];
    vi.spyOn(db, "retrySlackIntakeReaction").mockRejectedValueOnce(new Error("database unavailable"));
    agent.mockImplementationOnce(async () => { throw new Error("agent crashed"); });
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("400.1", "Add SSO")); });
    await db.recordSlackIntakeReaction(reaction());
    await db.recordSlackIntakeReaction(reaction({ messageTs: "400.1" }));
    await intake.processReactions();
    expect(agent).toHaveBeenCalledTimes(2);
    expect(linear.created).toEqual([expect.objectContaining({ title: "Add SSO" })]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([expect.objectContaining({ messageTs: "100.2", attempts: 0 })]);
  });

  it("does not reuse a failed destination lookup for later ticket attempts in the same run", async () => {
    seedThread();
    linear.listSlackTicketDestinations.mockRejectedValueOnce(new Error("rate limited"));
    agent.mockImplementation(async ({ tools }) => {
      await expect(call(tools, "create_ticket", ticketArgs("100.2"))).rejects.toThrow("rate limited");
      await call(tools, "create_ticket", ticketArgs("100.2"));
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
    expect(linear.delegated).toEqual([linear.created[0]!.id]);
  });

  it("retries a rejected create using the same reserved id", async () => {
    seedThread();
    linear.createSlackCodingTicket.mockRejectedValueOnce(new Error("temporarily unavailable"));
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    now += RETRY_BASE;
    await intake.processReactions();
    const ids = linear.createSlackCodingTicket.mock.calls.map(([input]) => input.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(linear.created).toHaveLength(1);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("records a new reactor when an ignored request is triggered again", async () => {
    seedThread();
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UEXTERNAL" }));
    await intake.processReactions();
    expect(agent).not.toHaveBeenCalled();
    expect(await db.recordSlackIntakeReaction(reaction())).toBe(true);
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
    expect(linear.created[0]!.description).toContain("Dana Member");
  });

  it("rejects Linear destinations that list_ticket_destinations did not return for the team", async () => {
    seedThread();
    agent.mockImplementation(async ({ tools }) => {
      await expect(call(tools, "create_ticket", { ...ticketArgs("100.2"), teamId: "team-x" })).rejects.toThrow("teamId team-x");
      await expect(call(tools, "create_ticket", { ...ticketArgs("100.2"), teamId: "team-2", projectId: "project-1" })).rejects.toThrow("projectId project-1");
      await expect(call(tools, "create_ticket", { ...ticketArgs("100.2"), cycleId: "cycle-2" })).rejects.toThrow("cycleId cycle-2");
      await call(tools, "create_ticket", { ...ticketArgs("100.2"), projectId: "project-1" });
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toEqual([expect.objectContaining({ teamId: "team-1", projectId: "project-1" })]);
    expect(linear.listSlackTicketDestinations).toHaveBeenCalledTimes(1);
  });

  it("honors the deployment's async reactor authorization and reaction instructions", async () => {
    seedThread();
    policy.isEligibleReactor = async (user) => user.id === "UEXTERNAL";
    policy.reactionInstructions = "Track this partner's request.";
    agent.mockImplementation(async ({ task, prompt, tools }) => {
      expect(task.slackChannelIntake).toBe("reaction");
      expect(prompt).toContain(policy.reactionInstructions);
      await call(tools, "create_ticket", ticketArgs("100.2"));
    });
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UEXTERNAL" }));
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
  });

  it("adopts the created ticket when delegation needs retrying", async () => {
    seedThread();
    linear.delegateSlackCodingTicket.mockRejectedValueOnce(new Error("delegation unavailable"));
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    now += RETRY_BASE;
    await intake.processReactions();
    expect(linear.createSlackCodingTicket).toHaveBeenCalledTimes(1);
    expect(linear.delegateSlackCodingTicket.mock.calls.map(([id]) => id)).toEqual([linear.created[0]!.id, linear.created[0]!.id]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("does not rerun the agent after a completed ticket when queue completion needs retrying", async () => {
    seedThread();
    vi.spyOn(db, "finishSlackIntakeReaction").mockRejectedValueOnce(new Error("database unavailable"));
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    now += RETRY_BASE;
    await intake.processReactions();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(linear.created).toHaveLength(1);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("reuses the reserved issue id after an uncertain create", async () => {
    seedThread();
    let persisted: { id: string; identifier: string; url: string } | null = null;
    Object.assign(linear, { getTicket: vi.fn(async () => persisted) });
    linear.createSlackCodingTicket.mockImplementation(async (input) => {
      persisted = { id: (input as { id: string }).id, identifier: "DEN-99", url: "https://linear.app/issue/DEN-99" };
      throw new Error("response lost after creation");
    });
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_ticket", ticketArgs("100.2")); });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    now += RETRY_BASE;
    await intake.processReactions();
    expect(linear.createSlackCodingTicket).toHaveBeenCalledTimes(1);
    expect(persisted!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(linear.delegated).toEqual([persisted!.id]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

});
