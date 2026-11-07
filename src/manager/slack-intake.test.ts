import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BearMetalConfig, SlackIntakePolicy } from "../customization/types.js";
import { InvalidInputLinearError } from "@linear/sdk";
import { SqlDbClient } from "../db/client.js";
import { LinearRefusedError } from "../shared/integrations/linear/client.js";
import { createLogger } from "../shared/logger.js";
import type { runSlackAgent } from "../worker/slack-agent.js";
import { SLACK_INTAKE_REACTION_MAX_ATTEMPTS, SlackIntake } from "./slack-intake.js";
import { slackTsFromMs, type SlackIntakeChannel, type SlackIntakeMessage, type SlackIntakeUser } from "./slack-intake-api.js";

const DAY = 24 * 60 * 60 * 1000;
const RETRY_BASE = 5 * 60 * 1000;
const DUE = "9999-12-31T00:00:00.000Z";
const NOW = Date.UTC(2026, 10, 5, 12);

type AgentInput = Parameters<typeof runSlackAgent>[0];

function message(ts: string, user: string, text: string, extra: Partial<SlackIntakeMessage> = {}): SlackIntakeMessage {
  return { ts, threadTs: null, user, text, replyCount: 0, fileCount: 0, ...extra };
}

function ts(offsetMs: number): string {
  return slackTsFromMs(NOW + offsetMs);
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
  history: Record<string, SlackIntakeMessage[]> = {};
  threads: Record<string, SlackIntakeMessage[]> = {};
  historyCalls: Array<{ channelId: string; oldest: string; latest: string }> = [];

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
  readHistory = async (channelId: string, oldest: string, latest: string) => {
    this.historyCalls.push({ channelId, oldest, latest });
    return this.history[channelId] ?? [];
  };
  readThread = async (channelId: string, threadTs: string) => this.threads[`${channelId}/${threadTs}`] ?? [];
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
  created: Array<{ teamId: string; title: string; description: string; assigneeId?: string }> = [];
  delegated: string[] = [];
  labeled: Array<{ ticketId: string; labels: readonly string[] }> = [];
  createSlackCodingTicket = vi.fn(async (input: { teamId: string; title: string; description: string; assigneeId?: string }) => {
    this.created.push(input);
    const n = this.created.length;
    return { id: `issue-${n}`, identifier: `DEN-${n}`, url: `https://linear.app/issue/DEN-${n}` };
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
  sourceTs, teamId: "team-1", title,
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
  let policy: SlackIntakePolicy;

  beforeEach(async () => {
    db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    slack = new FakeSlack();
    linear = new FakeLinear();
    agent = vi.fn(async () => {});
    now = NOW;
    policy = { channelNamePattern: /^support-.+$/, triggerReaction: "ticket", ownerEmail: "owner@example.com",
      sweepIntervalMs: DAY, initialLookbackMs: DAY, readOnlyChannels: true,
      isEligibleReactor: (user, workspaceId) => user.teamId === workspaceId && !user.isBot && !user.deleted && !user.guest,
      reactionInstructions: "Track the flagged request.", sweepInstructions: "Find unresolved engineering requests." };
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

  const reaction = (overrides: Partial<{ channelId: string; messageTs: string; reactorUserId: string }> = {}) => ({
    workspaceId: "T1", channelId: "CACME", messageTs: "100.2", reactorUserId: "UMEMBER", ...overrides,
  });

  function seedThread() {
    slack.threads["CACME/100.1"] = [
      message("100.1", "UEXTERNAL", "Our auditors want logs.", { replyCount: 2 }),
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
      await call(tools, "create_intake_ticket", ticketArgs("100.2"));
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
    expect(linear.delegated).toEqual(["issue-1"]);
    expect(linear.labeled).toEqual([{ ticketId: "issue-1", labels: ["signal:slack"] }]);
    expect(await db.hasSlackLinkedTicket("issue-1")).toBe(true);
    expect(await db.getSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.2" })).toMatchObject({ state: "delegated", ticketIdentifier: "DEN-1", trigger: "reaction" });
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

  it("does not create a second ticket for repeated reactions or a message a sweep already ticketed", async () => {
    seedThread();
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_intake_ticket", ticketArgs("100.2")); });
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
    // The sweep path claims the thread root; the later reaction on the reply refers to the same request.
    const sweep = await db.claimSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.1", threadTs: "100.1", trigger: "sweep", title: "Export audit logs" });
    await db.attachSlackIntakeTicket(sweep.ticket, { id: "issue-9", identifier: "DEN-9", url: "https://linear.app/issue/DEN-9" });
    await db.markSlackIntakeTicketDelegated(sweep.ticket);
    agent.mockImplementation(async ({ tools, prompt }) => {
      expect(prompt).toContain("\"ticket\":\"DEN-9\"");
      await expect(call(tools, "report_already_tracked", { sourceTs: "100.9", reason: "x" })).rejects.toThrow("No delegated intake ticket");
      await call(tools, "report_already_tracked", { sourceTs: "100.1", reason: "Same CSV export request" });
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toEqual([]);
    expect(await db.getSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.2" })).toBeNull();
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
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_intake_ticket", ticketArgs("400.1", "Add SSO")); });
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
      await expect(call(tools, "create_intake_ticket", ticketArgs("100.2"))).rejects.toThrow("rate limited");
      await call(tools, "create_intake_ticket", ticketArgs("100.2"));
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
    expect(linear.delegated).toEqual(["issue-1"]);
  });

  it.each([
    ["an SDK rejection", () => new InvalidInputLinearError({ message: "Linear rejected the issue" })],
    ["an unsuccessful mutation payload", () => new LinearRefusedError("Linear did not create the coding ticket")],
  ])("retries a Linear creation refused with %s on the next attempt without duplicating it", async (_name, refusal) => {
    seedThread();
    linear.createSlackCodingTicket.mockRejectedValueOnce(refusal());
    agent.mockImplementation(async ({ tools }) => { await call(tools, "create_intake_ticket", ticketArgs("100.2")); });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(await db.getSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.2" })).toMatchObject({ state: "failed", ticketId: null });
    now += RETRY_BASE;
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
    expect(linear.delegated).toEqual(["issue-1"]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("keeps an unknown-outcome Linear creation unresolved instead of creating it again", async () => {
    seedThread();
    linear.createSlackCodingTicket.mockRejectedValueOnce(new Error("socket hang up"));
    let error: unknown;
    agent.mockImplementation(async ({ tools }) => {
      error = await call(tools, "create_intake_ticket", ticketArgs("100.2")).catch((err: unknown) => err);
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(String(error)).toContain("unresolved ticket creation");
    expect(await db.getSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.2" })).toMatchObject({ state: "creating", ticketId: null });
    now += RETRY_BASE;
    await intake.processReactions();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(linear.createSlackCodingTicket).toHaveBeenCalledTimes(1);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("refuses to recreate a ticket whose earlier creation outcome is unknown", async () => {
    seedThread();
    await db.claimSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: "100.2", threadTs: "100.1", trigger: "sweep", title: "t" });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(agent).not.toHaveBeenCalled();
    expect(linear.created).toEqual([]);
    expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
  });

  it("rejects Linear destinations that list_ticket_destinations did not return for the team", async () => {
    seedThread();
    agent.mockImplementation(async ({ tools }) => {
      await expect(call(tools, "create_intake_ticket", { ...ticketArgs("100.2"), teamId: "team-x" })).rejects.toThrow("teamId team-x");
      await expect(call(tools, "create_intake_ticket", { ...ticketArgs("100.2"), teamId: "team-2", projectId: "project-1" })).rejects.toThrow("projectId project-1");
      await expect(call(tools, "create_intake_ticket", { ...ticketArgs("100.2"), cycleId: "cycle-2" })).rejects.toThrow("cycleId cycle-2");
      await call(tools, "create_intake_ticket", { ...ticketArgs("100.2"), projectId: "project-1" });
    });
    await db.recordSlackIntakeReaction(reaction());
    await intake.processReactions();
    expect(linear.created).toEqual([expect.objectContaining({ teamId: "team-1", projectId: "project-1" })]);
    expect(linear.listSlackTicketDestinations).toHaveBeenCalledTimes(1);
  });

  it("uses custom channel selection, timing, instructions and task context", async () => {
    policy.channelNamePattern = /^engineering$/;
    policy.sweepIntervalMs = 2 * 60 * 60 * 1000;
    policy.initialLookbackMs = 7 * DAY;
    policy.sweepInstructions = "Only track release automation requests.";
    slack.history.CENG = [message(ts(-60000), "UMEMBER", "Please automate release notes")];
    agent.mockImplementation(async ({ task, prompt, tools }) => {
      expect(task.slackIntake).toBe("sweep");
      expect(prompt).toContain(policy.sweepInstructions);
      expect(prompt).not.toContain("BlueBear");
      await call(tools, "finish_review", { summary: "Reviewed." });
    });
    await intake.sweepIfDue();
    expect(slack.historyCalls).toEqual([{ channelId: "CENG", oldest: ts(-7 * DAY), latest: ts(0) }]);
    now += policy.sweepIntervalMs - 1;
    await intake.sweepIfDue();
    expect(slack.historyCalls).toHaveLength(1);
    now += 1;
    await intake.sweepIfDue();
    expect(slack.historyCalls[1]).toEqual({ channelId: "CENG", oldest: ts(0), latest: ts(policy.sweepIntervalMs) });
  });

  it("honors the deployment's async reactor authorization and reaction instructions", async () => {
    seedThread();
    policy.isEligibleReactor = async (user) => user.id === "UEXTERNAL";
    policy.reactionInstructions = "Track this partner's request.";
    agent.mockImplementation(async ({ task, prompt, tools }) => {
      expect(task.slackIntake).toBe("reaction");
      expect(prompt).toContain(policy.reactionInstructions);
      await call(tools, "create_intake_ticket", ticketArgs("100.2"));
    });
    await db.recordSlackIntakeReaction(reaction({ reactorUserId: "UEXTERNAL" }));
    await intake.processReactions();
    expect(linear.created).toHaveLength(1);
  });

  it("sweeps only joined selected channels over the last 24 hours on the first run, then from the previous sweep", async () => {
    slack.history.CACME = [message(ts(-2 * 60 * 60 * 1000), "UEXTERNAL", "Thanks, all good!")];
    slack.history.CENG = [message(ts(-60 * 1000), "UMEMBER", "please fix the build")];
    agent.mockImplementation(async ({ tools }) => { await call(tools, "finish_review", { summary: "No engineering work requested." }); });

    await intake.sweepIfDue();
    expect(slack.historyCalls).toEqual([{ channelId: "CACME", oldest: ts(-DAY), latest: ts(0) }]);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(linear.created).toEqual([]);

    now = NOW + DAY - 1;
    await intake.sweepIfDue();
    expect(slack.historyCalls).toHaveLength(1);

    now = NOW + DAY;
    slack.history.CACME = [];
    await intake.sweepIfDue();
    expect(slack.historyCalls[1]).toEqual({ channelId: "CACME", oldest: ts(0), latest: ts(DAY) });
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it("creates sweep tickets for actionable requests and skips sources it already ticketed", async () => {
    const root = ts(-60 * 60 * 1000);
    const reply = ts(-30 * 60 * 1000);
    slack.history.CACME = [message(root, "UEXTERNAL", "SSO login fails for our EU tenant", { replyCount: 1 })];
    slack.threads[`CACME/${root}`] = [
      message(root, "UEXTERNAL", "SSO login fails for our EU tenant", { replyCount: 1 }),
      message(reply, "UMEMBER", "Looking into it", { threadTs: root }),
    ];
    agent.mockImplementation(async ({ tools, prompt }) => {
      expect(prompt).toContain("SSO login fails");
      await expect(call(tools, "create_intake_ticket", ticketArgs("1.0"))).rejects.toThrow("not an eligible source");
      await call(tools, "create_intake_ticket", ticketArgs(root, "Fix SSO login for EU tenants"));
      await call(tools, "create_intake_ticket", ticketArgs(root, "Fix SSO login for EU tenants"));
      await expect(call(tools, "create_intake_ticket", ticketArgs(reply, "Investigate EU SSO"))).rejects.toThrow("at most one ticket per thread");
      await call(tools, "finish_review", { summary: "One SSO bug." });
    });
    await intake.sweep(NOW);
    expect(linear.created).toHaveLength(1);
    expect(linear.created[0]!.description).toContain("- Intake: Scheduled channel sweep");
    expect(await db.getSlackIntakeTicket({ workspaceId: "T1", channelId: "CACME", sourceTs: root })).toMatchObject({ state: "delegated", threadTs: root, trigger: "sweep" });

    await db.setSlackIntakeSweepCursor("T1", "CACME", ts(-DAY));
    agent.mockReset();
    agent.mockImplementation(async ({ tools, prompt }) => {
      expect(prompt).toContain("\"ticket\":\"DEN-1\"");
      await call(tools, "create_intake_ticket", ticketArgs(root, "Fix SSO login for EU tenants"));
      await expect(call(tools, "create_intake_ticket", ticketArgs(reply, "Fix SSO login again"))).rejects.toThrow("already has intake ticket DEN-1");
      await call(tools, "finish_review", { summary: "Already tracked." });
    });
    await intake.sweep(NOW + 1000);
    expect(linear.created).toHaveLength(1);
  });

  it("keeps a channel's cursor when its review fails so the next sweep covers it again", async () => {
    slack.history.CACME = [message(ts(-1000), "UEXTERNAL", "Can you add dark mode?")];
    await intake.sweep(NOW);
    expect(await db.getSlackIntakeSweepCursor("T1", "CACME")).toBeNull();
    expect(await db.getSlackIntakeLastSweep("T1")).toBe(new Date(NOW).toISOString());
  });
});
