import pino, { type Logger } from "pino";

export function createLogger(name: string, level?: string): Logger {
  return pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
