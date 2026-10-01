import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import type { DbClient, SlackThreadKey } from "../db/client.js";
import type { Logger } from "../shared/logger.js";

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    bot_id?: string;
  };
}

export function verifySlackSignature(body: Buffer, timestamp: string | undefined, signature: string | undefined, signingSecret: string): boolean {
  if (!timestamp || !signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createSlackEventsRouter(input: {
  db: DbClient;
  signingSecret: string;
  botUserId: string;
  workspaceId: string;
  logger: Logger;
  wake: (key: SlackThreadKey) => Promise<void>;
}): Router {
  if (!input.signingSecret || !input.botUserId || !input.workspaceId) throw new Error("Slack events require signing secret, bot user ID, and workspace ID");
  const router = Router();
  router.post("/events", raw({ type: "application/json", limit: "1mb" }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !verifySlackSignature(
        req.body,
        req.header("x-slack-request-timestamp"),
        req.header("x-slack-signature"),
        input.signingSecret,
      )) {
        res.sendStatus(401);
        return;
      }
      const payload = JSON.parse(req.body.toString("utf8")) as SlackEventEnvelope;
      if (payload.type === "event_callback" && payload.team_id !== input.workspaceId) {
        res.sendStatus(403);
        return;
      }
      if (payload.type === "url_verification") {
        if (!payload.challenge) throw new Error("Slack URL verification omitted challenge");
        res.type("text/plain").send(payload.challenge);
        return;
      }
      if (payload.type !== "event_callback") {
        res.sendStatus(200);
        return;
      }
      const event = payload.event;
      if (!event || (event.type !== "app_mention" && event.type !== "message")) {
        res.sendStatus(200);
        return;
      }
      if ((event.subtype && event.subtype !== "file_share") || event.bot_id || event.user === input.botUserId) {
        res.sendStatus(200);
        return;
      }
      if (!payload.team_id || !event.channel || !event.ts || !event.user) {
        throw new Error("Slack message event omitted workspace, channel, timestamp, or user");
      }
      const key: SlackThreadKey = {
        workspaceId: payload.team_id,
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
      };
      const activates = event.type === "app_mention" || (event.type === "message" && event.channel_type === "im" && !event.thread_ts);
      if (!activates && !event.thread_ts && !await input.db.hasSlackThread(key)) {
        res.sendStatus(200);
        return;
      }
      if (activates) await input.db.followSlackThread(key, event.ts);
      const inserted = await input.db.recordSlackMessage(key, event.ts);
      res.sendStatus(200);
      if (inserted && await input.db.hasSlackThread(key)) void input.wake(key).catch((err) => input.logger.error({ err, key }, "Slack thread wake failed"));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
