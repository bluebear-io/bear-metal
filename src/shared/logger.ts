import { pino, type Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  name: string;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({ level: options.level, name: options.name });
}
