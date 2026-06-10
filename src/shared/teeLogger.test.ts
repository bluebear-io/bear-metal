import { describe, it, expect, vi } from "vitest";
import { createTeeLogger, type LogSinkLine } from "./teeLogger.js";

describe("createTeeLogger", () => {
  it("forwards every line to the sink with the dashboard level taxonomy", async () => {
    const lines: LogSinkLine[] = [];
    const logger = createTeeLogger({
      level: "debug",
      name: "test",
      bindings: { runId: "r1" },
      sink: (line) => { lines.push(line); },
    });

    logger.debug("a debug");
    logger.info("an info");
    logger.warn("a warn");
    logger.error("an error");

    // pino multistream is synchronous over the JSON encoding path it uses, but yield once to be safe.
    await new Promise((r) => setImmediate(r));

    expect(lines.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(lines.map((l) => l.message)).toEqual(["a debug", "an info", "a warn", "an error"]);
    expect(lines.every((l) => typeof l.timestamp === "number")).toBe(true);
  });

  it("swallows sink errors so logging never breaks the worker", async () => {
    const sink = vi.fn(() => { throw new Error("sink boom"); });
    const logger = createTeeLogger({ level: "info", name: "test", sink });
    expect(() => logger.info("ok")).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(sink).toHaveBeenCalled();
  });
});
