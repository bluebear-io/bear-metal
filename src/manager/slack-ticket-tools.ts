import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateTaskCustomization } from "../customization/load.js";
import type { BearMetalConfig } from "../customization/types.js";
import type { LinearIntegration } from "../shared/integrations/linear/client.js";
import type { Logger } from "../shared/logger.js";

type TicketInput = Parameters<LinearIntegration["createSlackCodingTicket"]>[0];
type Ticket = Awaited<ReturnType<LinearIntegration["createSlackCodingTicket"]>>;
type TicketLinear = Pick<LinearIntegration, "createSlackCodingTicket" | "addLabelsByName" | "listSlackTicketDestinations">;

export class SlackTicketTools {
  private destinations?: ReturnType<TicketLinear["listSlackTicketDestinations"]>;

  constructor(private readonly linear: TicketLinear, private readonly config: BearMetalConfig, private readonly logger: Logger) {}

  readonly listDestinations = defineTool({
    name: "list_ticket_destinations",
    label: "List Linear destinations",
    description: "Mandatory lookup before supplying teamId, projectId, or cycleId to create_ticket or coding update_task. Returns teams, projects with teamIds, and cycles with teamId and dates. Use only IDs returned here and destinations belonging to the selected team.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(await this.getDestinations()) }], details: {} }),
  });

  private async getDestinations() {
    this.destinations ??= this.linear.listSlackTicketDestinations();
    try {
      return await this.destinations;
    } catch (err) {
      this.destinations = undefined;
      throw err;
    }
  }

  async validateDestination(args: Pick<TicketInput, "teamId" | "projectId" | "cycleId">): Promise<void> {
    const destinations = await this.getDestinations();
    if (!destinations.teams.some((team) => team.id === args.teamId)) throw new Error(`teamId ${args.teamId} is not a team returned by list_ticket_destinations`);
    if (args.projectId && !destinations.projects.some((project) => project.id === args.projectId && project.teamIds.includes(args.teamId))) {
      throw new Error(`projectId ${args.projectId} is not a project of team ${args.teamId} returned by list_ticket_destinations`);
    }
    if (args.cycleId && !destinations.cycles.some((cycle) => cycle.id === args.cycleId && cycle.teamId === args.teamId)) {
      throw new Error(`cycleId ${args.cycleId} is not a cycle of team ${args.teamId} returned by list_ticket_destinations`);
    }
  }

  async create(input: TicketInput, taskId: string, attach: ((ticket: Ticket) => Promise<void>) | undefined, existing?: Ticket | null): Promise<Ticket> {
    const ticket = existing ?? await this.linear.createSlackCodingTicket(input);
    // Attach before labels/delegation so the scheduler can identify Slack-originated tickets.
    await attach?.(ticket);
    try {
      const customization = validateTaskCustomization(await this.config.customizeTask({
        type: "coding", id: taskId, trigger: "slack", request: input.description,
      }));
      if (customization.ticketLabels?.length) {
        const missing = await this.linear.addLabelsByName(ticket.id, customization.ticketLabels);
        if (missing.length) this.logger.warn({ missing, ticketIssueId: ticket.id }, "ticket labels not found in Linear");
      }
    } catch (err) {
      this.logger.warn({ err, ticketIssueId: ticket.id }, "failed to apply ticket labels");
    }
    return ticket;
  }
}
