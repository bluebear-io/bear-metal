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
  const sinkStream = {
    write(chunk: string): void {
      try {
        const parsed = JSON.parse(chunk) as Record<string, unknown>;
        const msg = typeof parsed.msg === "string" ? parsed.msg : chunk.trim();
        const timestamp = typeof parsed.time === "number" ? parsed.time : Date.now();
        options.sink({ level: pickLevel(parsed.level), message: msg, timestamp });
      } catch {
        // Best-effort: a malformed pino line is logged-as-info with the raw chunk.
        try {
          options.sink({ level: "info", message: chunk.trim(), timestamp: Date.now() });
        } catch {
          // Sink errors are swallowed by contract.
        }
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
