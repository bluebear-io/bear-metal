import { describe, expect, it } from "vitest";
import { isActionableReviewThread } from "./client.js";
import type { ReviewThread } from "./types.js";

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
