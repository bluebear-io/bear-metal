import { pino, multistream, type Logger } from "pino";
import type { RunLogLevel } from "./dashboard/types.js";

export interface LogSinkLine {
  level: RunLogLevel;
  message: string;
  timestamp: number;
}

export interface TeeLoggerOptions {
  level: string;
  name: string;
  /** Bindings copied onto every line; useful for binding the runId/workerId/ticketId once. */
  bindings?: Record<string, unknown>;
  /** Receives every emitted line. Thrown errors are swallowed so logging never breaks the worker. */
  sink: (line: LogSinkLine) => void;
}

const PINO_LEVELS: Record<number, RunLogLevel> = {
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "error", // fatal collapses to error for the dashboard taxonomy
};

function pickLevel(numeric: unknown): RunLogLevel {
  if (typeof numeric === "number" && numeric in PINO_LEVELS) return PINO_LEVELS[numeric]!;
  return "info";
}

/**
 * pino logger that fans every line to stdout *and* a sink callback. Sink errors are swallowed
 * so a dashboard outage never blocks the worker. The returned logger should be passed through
 * the dispatch/pi pipeline so every line is bound to the active runId.
 */
export function createTeeLogger(options: TeeLoggerOptions): Logger {
  // Rate-limit the "sink is broken" stderr breadcrumb so a persistently failing dashboard
  // doesn't itself become a log-flood. One warn per minute is enough for an operator to notice
  // an empty log panel and correlate it with the worker process logs.
  let lastSinkErrorWarnAt = 0;
  const SINK_ERROR_WARN_INTERVAL_MS = 60_000;
  const warnSinkError = (err: unknown): void => {
    const now = Date.now();
    if (now - lastSinkErrorWarnAt < SINK_ERROR_WARN_INTERVAL_MS) return;
    lastSinkErrorWarnAt = now;
    // eslint-disable-next-line no-console
    console.error("[teeLogger] sink error swallowed:", err);
  };

  const safeSink = (line: LogSinkLine): void => {
    try {
      options.sink(line);
    } catch (err) {
      warnSinkError(err);
    }
  };

  const sinkStream = {
    write(chunk: string): void {
      try {
        const parsed = JSON.parse(chunk) as Record<string, unknown>;
        const msg = typeof parsed.msg === "string" ? parsed.msg : chunk.trim();
        const timestamp = typeof parsed.time === "number" ? parsed.time : Date.now();
        safeSink({ level: pickLevel(parsed.level), message: msg, timestamp });
      } catch (parseErr) {
        // Malformed pino line — ship the raw chunk as info so it still reaches the dashboard.
        // If the sink itself is broken, safeSink emits a rate-limited stderr breadcrumb.
        void parseErr;
        safeSink({ level: "info", message: chunk.trim(), timestamp: Date.now() });
      }
    },
  };

  // Stream-level defaults to "info" in pino multistream; align with the logger's configured
  // level so the sink isn't silently filtered when the logger is set to e.g. "debug".
  const streamLevel = options.level;
  const streams = [
    { level: streamLevel, stream: process.stdout },
    { level: streamLevel, stream: sinkStream as unknown as NodeJS.WritableStream },
  ];

  return pino(
    {
      level: options.level,
      name: options.name,
      base: options.bindings ?? {},
    },
    multistream(streams),
  );
}
