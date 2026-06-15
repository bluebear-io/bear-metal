import { pino, type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  name: string;
  /** Colorized, human-readable output for local dev. Defaults to JSON. */
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  if (options.pretty) {
    return pino({
      level: options.level,
      name: options.name,
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    });
  }
  return pino({ level: options.level, name: options.name });
}
