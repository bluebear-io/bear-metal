import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SqlDbClient } from "../db/client.js";
import { createLogger } from "../shared/logger.js";
import { createSlackEventsRouter } from "./slack-events.js";

const secret = "test-signing-secret";
const DUE = "9999-12-31T00:00:00.000Z";

function signed(body: object) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${text}`).digest("hex")}`;
  return { text, timestamp, signature };
}

describe("Slack event intake", () => {
  it.each(["app_mention", "message"])("does not activate customer conversations for %s", async (type) => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const key = { workspaceId: "T1", channelId: "C1", threadTs: "100.0" };
    await db.followSlackThread(key, "100.0");
    const wake = vi.fn(async () => {});
    const intakeWake = vi.fn();
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1",
      logger: createLogger({ name: "test", level: "silent" }), wake, isReadOnlyChannel: async () => true,
      intake: { triggerReaction: "bear_paw_seen", wake: intakeWake } }));
    const send = async (event: object) => {
      const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event });
      return request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text);
    };
    try {
      expect((await send({ type, channel: "C1", ts: "100.1", thread_ts: "100.0", user: "U1", text: "<@UBOT> help" })).status).toBe(200);
      expect(wake).not.toHaveBeenCalled();
      expect(await db.isSlackThreadFollowing(key)).toBe(false);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect((await send({ type: "reaction_added", reaction: "bear_paw_seen", user: "U1", item: { type: "message", channel: "C1", ts: "100.1" } })).status).toBe(200);
      expect(intakeWake).toHaveBeenCalledOnce();
      expect(wake).not.toHaveBeenCalled();
    } finally { await db.close(); }
  });
  it("abandons a deleted message and its pending edits", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const key = { workspaceId: "T1", channelId: "C1", threadTs: "100.0" };
    await db.followSlackThread(key, "100.0");
    await db.recordSlackMessage(key, "100.1");
    await db.recordSlackEdit(key, "100.2", "100.1", "U1", "Changed");
    const wake = vi.fn(async () => {});
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }), wake }));
    const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event: {
      type: "message", subtype: "message_deleted", channel: "C1", ts: "100.3", deleted_ts: "100.1",
      previous_message: { ts: "100.1", thread_ts: "100.0" },
    } });
    try {
      expect((await request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text)).status).toBe(200);
      expect(await db.listSlackPendingMessages(key)).toEqual([]);
      expect(wake).toHaveBeenCalledWith(key);
    } finally {
      await db.close();
    }
  });
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
      expect((await send({ type: "message", subtype: "message_changed", channel: "C1", ts: "100.35", message: { ts: "100.1", thread_ts: "100.0", user: "U1", text: "Changed old message" } })).status).toBe(200);
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
      const edit = { type: "message", subtype: "message_changed", channel: "C1", ts: "300.3", message: { ts: "300.2", thread_ts: "300.1", user: "U1", subtype: "file_share", text: "Use the new attachment" } };
      await send(edit);
      await send(edit);
      await send({ type: "message", subtype: "message_changed", channel: "C1", ts: "300.35", message: { ts: "300.2", thread_ts: "300.1", user: "UBOT", text: "Bot edit" } });
      await send({ type: "message", subtype: "file_share", channel: "C1", ts: "300.4", thread_ts: "300.1", user: "UBOT" });
      expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "C1", threadTs: "300.1" })).toEqual(["300.1", "300.2", "300.3"]);
      expect(wake).toHaveBeenCalledTimes(3);
    } finally {
      await db.close();
    }
  });

  it("records each member's intake reaction once and ignores other reactions", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const wakeIntake = vi.fn();
    const app = express();
    app.use("/slack", createSlackEventsRouter({
      db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }),
      wake: async () => {}, intake: { triggerReaction: "bear_paw_seen", wake: wakeIntake },
    }));
    const send = async (event: object) => {
      const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event });
      return request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text);
    };
    const reaction = { type: "reaction_added", user: "U1", reaction: "bear_paw_seen", item: { type: "message", channel: "C1", ts: "400.1" } };
    try {
      expect((await send(reaction)).status).toBe(200);
      expect((await send(reaction)).status).toBe(200);
      expect((await send({ ...reaction, reaction: "eyes" })).status).toBe(200);
      expect((await send({ ...reaction, item: { type: "file", file: "F1" } })).status).toBe(200);
      const [pending] = await db.listPendingSlackIntakeReactions(DUE);
      expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([{ workspaceId: "T1", channelId: "C1", messageTs: "400.1", reactorUserId: "U1", attempts: 0 }]);
      expect(wakeIntake).toHaveBeenCalledTimes(1);

      await db.finishSlackIntakeReaction(pending!, "ignored", "bot not in channel");
      expect((await send(reaction)).status).toBe(200);
      expect(await db.listPendingSlackIntakeReactions(DUE)).toHaveLength(1);
      expect(wakeIntake).toHaveBeenCalledTimes(2);

      await db.finishSlackIntakeReaction(pending!, "processed", null);
      expect((await send(reaction)).status).toBe(200);
      expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
      expect(wakeIntake).toHaveBeenCalledTimes(2);
    } finally {
      await db.close();
    }
  });

  it("ignores intake reactions when customer intake is not configured", async () => {
    const db = new SqlDbClient("sqlite::memory:", 5);
    await db.initSchema();
    const app = express();
    app.use("/slack", createSlackEventsRouter({ db, signingSecret: secret, botUserId: "UBOT", workspaceId: "T1", logger: createLogger({ name: "test", level: "silent" }), wake: async () => {} }));
    const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event: {
      type: "reaction_added", user: "U1", reaction: "bear_paw_seen", item: { type: "message", channel: "C1", ts: "400.1" },
    } });
    try {
      expect((await request(app).post("/slack/events").set("Content-Type", "application/json")
        .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text)).status).toBe(200);
      expect(await db.listPendingSlackIntakeReactions(DUE)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("activates every threaded DM and rejects unsigned requests", async () => {
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
        const { text, timestamp, signature } = signed({ type: "event_callback", team_id: "T1", event: { type: "message", channel_type: "im", channel: "D1", ts, thread_ts: "199.1", user: "U1" } });
        expect((await request(app).post("/slack/events").set("Content-Type", "application/json")
          .set("X-Slack-Request-Timestamp", timestamp).set("X-Slack-Signature", signature).send(text)).status).toBe(200);
        expect(await db.listSlackPendingMessages({ workspaceId: "T1", channelId: "D1", threadTs: "199.1" })).toContain(ts);
      }
      expect(await db.getSlackThreadActivation({ workspaceId: "T1", channelId: "D1", threadTs: "199.1" })).toEqual({ directMessage: true, mentionTimestamps: ["200.1", "200.2"] });
    } finally {
      await db.close();
    }
  });
});
