import type { DashboardClient, Logger, PullRequest, Ticket } from "../shared/index.js";
import type { BmStatus, RunLogLevel, RunTrigger } from "../shared/index.js";

export interface DashboardReporterDeps {
  client: DashboardClient;
  logger: Logger;
  /** Phase-1 display constant for tickets.maxAttempts (cap not yet enforced). */
  maxAttempts: number;
  /** Injected clock — keeps writes deterministic in tests and avoids ambient Date.now(). */
  now?: () => Date;
}

/** A run in flight, identified together with its ticket (used by Ticket-holding callers). */
export interface RunRef {
  ticket: Ticket;
  runId: string;
  workerId: string | null;
  attemptNumber: number;
  trigger: RunTrigger;
}

const prId = (pr: PullRequest): string => `${pr.owner}/${pr.repo}#${pr.number}`;

/**
 * Projects agent lifecycle moments into dashboard rows/events. Owns the bm_status mapping.
 * Ticket-holding callers (scheduler/handler) update ticket rows; the worker uses the *ById
 * methods (it has only a ticket id, not the full Linear ticket) and never writes ticket rows.
 */
export class DashboardReporter {
  private readonly client: DashboardClient;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(deps: DashboardReporterDeps) {
    this.client = deps.client;
    this.maxAttempts = deps.maxAttempts;
    this.now = deps.now ?? (() => new Date());
  }

  private ms(): number {
    return this.now().getTime();
  }

  private ticketPayload(ticket: Ticket, bmStatus: BmStatus, attemptCount: number, completedAt: number | null) {
    const t = this.ms();
    return {
      id: ticket.id,
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      url: ticket.url,
      branchName: ticket.branchName,
      linearStatusName: ticket.status.name,
      linearStatusType: ticket.status.type,
      labels: ticket.labels,
      bmStatus,
      attemptCount,
      maxAttempts: this.maxAttempts,
      createdAt: t,
      updatedAt: t,
      completedAt,
    };
  }

  // ---- Ticket-holding callers (scheduler / handler) ----

  async ticketDiscovered(ticket: Ticket): Promise<void> {
    await this.client.upsertTicket(this.ticketPayload(ticket, "discovered", 0, null));
    await this.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "ticket_discovered", summary: `Discovered ${ticket.identifier}`, payloadJson: null, createdAt: this.ms() });
  }

  async runDispatched(ref: RunRef): Promise<void> {
    const t = this.ms();
    await this.client.upsertRun({ id: ref.runId, ticketId: ref.ticket.id, attemptNumber: ref.attemptNumber, workerId: null, trigger: ref.trigger, status: "dispatched", contextJson: null, startedAt: null, endedAt: null, stopReason: null, error: null, createdAt: t });
    await this.client.upsertTicket(this.ticketPayload(ref.ticket, "dispatched", ref.attemptNumber, null));
    await this.client.recordEvent({ ticketId: ref.ticket.id, runId: ref.runId, workerId: null, source: "manager", type: "dispatched", summary: `Dispatched attempt ${ref.attemptNumber}`, payloadJson: null, createdAt: t });
  }

  async ticketInProgress(ticket: Ticket, attemptCount: number): Promise<void> {
    await this.client.upsertTicket(this.ticketPayload(ticket, "in_progress", attemptCount, null));
  }

  async prOpened(ticket: Ticket, pr: PullRequest): Promise<void> {
    const t = this.ms();
    await this.client.upsertPullRequest({ id: prId(pr), ticketId: ticket.id, number: pr.number, title: pr.title, headRef: pr.headRef, state: pr.state, draft: pr.draft, merged: pr.merged, url: pr.url, lastRunId: null, createdAt: t, updatedAt: t });
    await this.client.upsertTicket(this.ticketPayload(ticket, "pr_open", 0, null));
    await this.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "pr_opened", summary: `PR #${pr.number} opened`, payloadJson: null, createdAt: t });
  }

  async ciFailed(ticket: Ticket, summary: string): Promise<void> {
    const t = this.ms();
    await this.client.upsertTicket(this.ticketPayload(ticket, "ci_failed", 0, null));
    await this.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "ci", type: "ci_failed", summary, payloadJson: null, createdAt: t });
  }

  async delegatedBack(ticket: Ticket, summary: string): Promise<void> {
    await this.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "delegated_back", summary, payloadJson: null, createdAt: this.ms() });
  }

  async ticketCompleted(ticket: Ticket): Promise<void> {
    const t = this.ms();
    await this.client.upsertTicket(this.ticketPayload(ticket, "completed", 0, t));
    await this.client.recordEvent({ ticketId: ticket.id, runId: null, workerId: null, source: "manager", type: "ticket_completed", summary: `Completed ${ticket.identifier}`, payloadJson: null, createdAt: t });
  }

  // ---- Worker (id-based; never writes ticket rows) ----

  async workerUpsert(workerId: string, name: string, status: "idle" | "busy", currentRunId: string | null, startedAt: number): Promise<void> {
    const t = this.ms();
    await this.client.upsertWorker({ id: workerId, name, status, currentRunId, lastHeartbeatAt: t, startedAt, updatedAt: t });
  }

  async runStartedById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger): Promise<void> {
    const t = this.ms();
    await this.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "running", contextJson: null, startedAt: t, endedAt: null, stopReason: null, error: null, createdAt: t });
  }

  async runSucceededById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger): Promise<void> {
    const t = this.ms();
    await this.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "succeeded", contextJson: null, startedAt: null, endedAt: t, stopReason: "completed", error: null, createdAt: t });
  }

  async runCrashedById(runId: string, ticketId: string, workerId: string, attemptNumber: number, trigger: RunTrigger, error: string): Promise<void> {
    const t = this.ms();
    await this.client.upsertRun({ id: runId, ticketId, attemptNumber, workerId, trigger, status: "crashed", contextJson: null, startedAt: null, endedAt: t, stopReason: "crash", error, createdAt: t });
    await this.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "worker_crashed", summary: error, payloadJson: null, createdAt: t });
  }

  async recordPrOpenedById(ticketId: string, pr: { owner: string; repo: string; number: number }, runId: string): Promise<void> {
    await this.client.recordEvent({ ticketId, runId, workerId: null, source: "worker", type: "pr_opened", summary: `PR #${pr.number} opened`, payloadJson: JSON.stringify(pr), createdAt: this.ms() });
  }

  async progressById(ticketId: string, runId: string, workerId: string, summary: string): Promise<void> {
    await this.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "progress", summary, payloadJson: null, createdAt: this.ms() });
  }

  async branchCreatedById(ticketId: string, runId: string, workerId: string, summary: string): Promise<void> {
    await this.client.recordEvent({ ticketId, runId, workerId, source: "worker", type: "branch_created", summary, payloadJson: null, createdAt: this.ms() });
  }

  async runLog(runId: string, message: string, level: RunLogLevel, timestamp: number): Promise<void> {
    await this.client.recordRunLog({ runId, message, level, timestamp });
  }
}
