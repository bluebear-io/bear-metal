import { describe, expect, it } from "vitest";
import { isActionableReviewThread, isHumanTakeover, type BotIdentity } from "./client.js";
import type { PullRequestCommit, ReviewThread } from "./types.js";

function makeThread(comments: Array<{ author: string | null }>): ReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    path: "src/file.ts",
    line: 1,
    comments: comments.map((c, i) => ({
      id: `comment-${i}`,
      databaseId: i,
      body: "comment body",
      author: c.author,
      url: `https://github.com/acme/repo/pull/1#discussion_r${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      path: "src/file.ts",
      line: 1,
      originalLine: 1,
      diffHunk: "@@",
    })),
  };
}

describe("isActionableReviewThread", () => {
  const botLogin = "bear-metal[bot]";

  it("is actionable when the latest comment is from a human reviewer", () => {
    const thread = makeThread([{ author: "reviewer" }]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(true);
  });

  it("is not actionable when the latest comment is from bear-metal", () => {
    const thread = makeThread([{ author: "reviewer" }, { author: "bear-metal[bot]" }]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(false);
  });

  it("is actionable when a human replied after bear-metal", () => {
    const thread = makeThread([
      { author: "bear-metal[bot]" },
      { author: "reviewer" },
    ]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(true);
  });

  it("is actionable when the latest comment has a null author", () => {
    const thread = makeThread([{ author: null }]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(true);
  });

  it("is actionable when the thread has no comments", () => {
    const thread = makeThread([]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(true);
  });

  it("does not treat other bots as bear-metal", () => {
    const thread = makeThread([{ author: "some-other-bot[bot]" }]);
    expect(isActionableReviewThread(thread, botLogin)).toBe(true);
  });
});

function commit(sha: string, authorLogin: string | null): PullRequestCommit {
  return {
    sha,
    author: authorLogin ? { login: authorLogin, id: 1 } : null,
    committer: authorLogin ? { login: authorLogin, id: 1 } : null,
  };
}

describe("isHumanTakeover", () => {
  const botLogin = "bear-metal[bot]";

  it("returns false when there are no commits", () => {
    expect(isHumanTakeover([], botLogin)).toBe(false);
  });

  it("returns false when bear-metal never pushed (no commit to take over from)", () => {
    expect(isHumanTakeover([commit("a", "alice"), commit("b", "bob")], botLogin)).toBe(false);
  });

  it("returns false when the latest commit is from bear-metal", () => {
    expect(
      isHumanTakeover([commit("a", "alice"), commit("b", botLogin)], botLogin),
    ).toBe(false);
  });

  it("returns true when a human commit follows a bear-metal commit", () => {
    expect(
      isHumanTakeover([commit("a", botLogin), commit("b", "alice")], botLogin),
    ).toBe(true);
  });

  it("matches the bot by committer when author is the human (e.g. amended commits)", () => {
    const botCommit: PullRequestCommit = {
      sha: "a",
      author: { login: "alice", id: 1 },
      committer: { login: botLogin, id: 2 },
    };
    expect(isHumanTakeover([botCommit, commit("b", "alice")], botLogin)).toBe(true);
  });

  it("treats unmatched commit author (null) as not bear-metal", () => {
    const unknown: PullRequestCommit = { sha: "a", author: null, committer: null };
    expect(isHumanTakeover([commit("x", botLogin), unknown], botLogin)).toBe(true);
  });

  it("returns true for [bot, human, bot] — bot pushed again after human took over", () => {
    expect(
      isHumanTakeover(
        [commit("a", botLogin), commit("b", "alice"), commit("c", botLogin)],
        botLogin,
      ),
    ).toBe(true);
  });
});

describe("isHumanTakeover — numeric ID matching (BotIdentity)", () => {
  const BOT_USER_ID = 292051303;
  const HUMAN_ID = 99;
  const bot: BotIdentity = { login: "bear-metal-app[bot]", id: null, numericId: 1, userNumericId: BOT_USER_ID };

  function botCommit(sha: string): PullRequestCommit {
    // Simulates real bot commits: author unresolved (null), committer matched by ID.
    return { sha, author: null, committer: { login: "installer", id: BOT_USER_ID } };
  }

  function humanCommit(sha: string): PullRequestCommit {
    return { sha, author: { login: "alice", id: HUMAN_ID }, committer: { login: "alice", id: HUMAN_ID } };
  }

  it("returns false when no bot commit exists", () => {
    expect(isHumanTakeover([humanCommit("a"), humanCommit("b")], bot)).toBe(false);
  });

  it("returns false when all commits after the first bot commit are also bot", () => {
    expect(isHumanTakeover([botCommit("a"), botCommit("b"), botCommit("c")], bot)).toBe(false);
  });

  it("returns true when a human commit follows a bot commit", () => {
    expect(isHumanTakeover([botCommit("a"), humanCommit("b")], bot)).toBe(true);
  });

  it("returns true for [bot, human, bot] — bot pushing again does not reset takeover", () => {
    expect(isHumanTakeover([botCommit("a"), humanCommit("b"), botCommit("c")], bot)).toBe(true);
  });
});
