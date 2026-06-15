import { describe, expect, it } from "vitest";

import { formatDateTime, formatDuration, formatDurationMs, parseLabels } from "./format.js";

describe("format helpers", () => {
  describe("formatDateTime", () => {
    it("returns an em dash for null values", () => {
      expect(formatDateTime(null)).toBe("—");
    });

    it("formats ISO timestamps as readable local strings containing the year", () => {
      const formatted = formatDateTime("2026-06-09T10:05:00.000Z");

      expect(formatted).toContain("2026");
      expect(formatted).not.toBe("2026-06-09T10:05:00.000Z");
    });
  });

  describe("formatDuration", () => {
    it("returns an em dash when the start is null", () => {
      expect(formatDuration(null, "2026-06-09T10:45:00.000Z")).toBe("—");
    });

    it("returns in progress when the end is null", () => {
      expect(formatDuration("2026-06-09T10:00:00.000Z", null)).toBe("in progress");
    });

    it("formats a 45 minute span in minutes", () => {
      expect(formatDuration("2026-06-09T10:00:00.000Z", "2026-06-09T10:45:00.000Z")).toBe("45m");
    });

    it("formats spans of at least 60 minutes as hours and minutes", () => {
      expect(formatDuration("2026-06-09T10:00:00.000Z", "2026-06-09T12:05:00.000Z")).toBe("2h 5m");
    });
  });

  describe("formatDurationMs", () => {
    it("returns an em dash for null values", () => {
      expect(formatDurationMs(null)).toBe("—");
    });

    it("formats six minutes in milliseconds", () => {
      expect(formatDurationMs(6 * 60 * 1000)).toBe("6m");
    });

    it("formats durations of at least 60 minutes as hours and minutes", () => {
      expect(formatDurationMs(95 * 60 * 1000)).toBe("1h 35m");
    });
  });

  describe("parseLabels", () => {
    it("returns only string entries from valid JSON arrays", () => {
      expect(parseLabels('["frontend", 42, "api", null, {"name":"ops"}]')).toEqual(["frontend", "api"]);
    });

    it("returns an empty array for invalid JSON", () => {
      expect(parseLabels("not json")).toEqual([]);
    });
  });
});
