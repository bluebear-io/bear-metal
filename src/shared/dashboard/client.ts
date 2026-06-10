import type { Logger } from "../logger.js";
import type {
  TicketPayload, WorkerPayload, RunPayload, PullRequestPayload, CiRunPayload,
  CiCheckPayload, ReviewThreadPayload, EventPayload,
} from "./types.js";

export interface DashboardClientOptions {
  baseUrl: string;
  token: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface DashboardClient {
  upsertTicket(p: TicketPayload): Promise<void>;
  upsertWorker(p: WorkerPayload): Promise<void>;
  upsertRun(p: RunPayload): Promise<void>;
  upsertPullRequest(p: PullRequestPayload): Promise<void>;
  upsertCiRun(p: CiRunPayload): Promise<void>;
  /** Replace the failing checks attached to a CI run (mirrors the latest poll result). */
  replaceCiChecks(ciRunId: string, checks: CiCheckPayload[]): Promise<void>;
  /** Replace the review threads attached to a PR (mirrors the latest poll result). */
  replaceReviewThreads(prId: string, threads: ReviewThreadPayload[]): Promise<void>;
  recordEvent(p: EventPayload): Promise<void>;
}

/**
 * Best-effort transport to the dashboard write API. The dashboard is a read model, not the
 * system of record, so a failed write is logged and swallowed — it must never break the agent
 * loop. (Approved deviation from the repo's fail-fast rule; see DEN-2288 spec.)
 */
export function createDashboardClient(options: DashboardClientOptions): DashboardClient {
  const { baseUrl, token, logger } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = baseUrl.replace(/\/$/, "");

  async function send(method: "PUT" | "POST", path: string, body: unknown): Promise<void> {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = typeof res.text === "function" ? await res.text().catch(() => "") : "";
        logger.warn({ path, status: res.status, detail }, "dashboard write rejected");
      }
    } catch (err) {
      logger.warn({ err, path }, "dashboard write failed (ignored)");
    }
  }

  return {
    upsertTicket: (p) => send("PUT", `/api/tickets/${encodeURIComponent(p.id)}`, p),
    upsertWorker: (p) => send("PUT", `/api/workers/${encodeURIComponent(p.id)}`, p),
    upsertRun: (p) => send("PUT", `/api/runs/${encodeURIComponent(p.id)}`, p),
    upsertPullRequest: (p) => send("PUT", `/api/pull-requests/${encodeURIComponent(p.id)}`, p),
    upsertCiRun: (p) => send("PUT", `/api/ci-runs/${encodeURIComponent(p.id)}`, p),
    replaceCiChecks: (ciRunId, checks) =>
      send("PUT", `/api/ci-runs/${encodeURIComponent(ciRunId)}/checks`, { checks }),
    replaceReviewThreads: (prId, threads) =>
      send("PUT", `/api/pull-requests/${encodeURIComponent(prId)}/review-threads`, { threads }),
    recordEvent: (p) => send("POST", `/api/events`, p),
  };
}
