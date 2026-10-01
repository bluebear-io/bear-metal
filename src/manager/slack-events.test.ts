import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import { createSlackEventsRouter } from "./slack-events.js";

const secret = "test-signing-secret";

function signed(body: object) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${text}`).digest("hex")}`;
  return { text, timestamp, signature };
}

describe("Slack event intake", () => {
  it("starts at a mention inside an existing thread, deduplicates it, follows later replies, and ignores self messages", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const wake = vi.fn(async () => {});
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }), wake }));
    const send = async (event: object) => {
      const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event });
      return request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text);
    };
    try {
      expect((await send({ type: "message", channel: "C1", ts: "100.1", thread_ts: "100.0", user: "U1" })).status).toBe(200);
      expect((await send({ type: "message", channel: "C1", ts: "100.3", thread_ts: "100.0", user: "U2" })).status).toBe(200);
      expect(await db.listSlackPendingThreads()).toEqual([]);
      expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "C1", threadTs: "100.0" })).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
      expect((await send({ type: "app_mention", channel: "C1", ts: "100.2", thread_ts: "100.0", user: "U1" })).status).toBe(200);
      expect((await send({ type: "app_mention", channel: "C1", ts: "100.2", thread_ts: "100.0", user: "U1" })).status).toBe(200);
      expect((await send({ type: "message", channel: "C1", ts: "100.35", thread_ts: "100.0", user: "UBOT" })).status).toBe(200);
      expect((await send({ type: "message", channel: "C1", ts: "100.4", thread_ts: "100.0", user: "U2" })).status).toBe(200);
      expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "C1", threadTs: "100.0" })).toEqual(["100.2", "100.4"]);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });

  it("records human file-share messages in followed threads", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const wake = vi.fn(async () => {});
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }), wake }));
    const send = async (event: object) => {
      const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event });
      return request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text);
    };
    try {
      await send({ type: "app_mention", channel: "C1", ts: "300.1", user: "U1" });
      await send({ type: "message", subtype: "file_share", channel: "C1", ts: "300.2", thread_ts: "300.1", user: "U1", files: [{ id: "F1" }] });
      await send({ type: "message", subtype: "message_changed", channel: "C1", ts: "300.3", thread_ts: "300.1", user: "U1" });
      await send({ type: "message", subtype: "file_share", channel: "C1", ts: "300.4", thread_ts: "300.1", user: "UBOT" });
      expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "C1", threadTs: "300.1" })).toEqual(["300.1", "300.2"]);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });

  it("treats each top-level DM as a separate followed thread and rejects unsigned requests", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }), wake: async () => {} }));
    try {
      expect((await request(app).post("/slack/events").set("Content-Type", "application/json").send("{}" )).status).toBe(401);
      const foreign = signed({ type: "event_callback", team_id: "T2", event: { type: "message", channel_type: "im", channel: "D1", ts: "199.0", user: "U1" } });
      expect((await request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", foreign.timestamp).set("X-Slack-Signature", foreign.signature).send(foreign.text)).status).toBe(403);
      for (const ts of ["200.1", "200.2"]) {
        const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", ts, user: "U1" } });
        expect((await request(app).post("/slack/events").set("Content-Type", "application/json")
          .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text)).status).toBe(200);
        expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "D1", threadTs: ts })).toEqual([ts]);
      }
    } finally {
      await db.close();
    }
  });
});
