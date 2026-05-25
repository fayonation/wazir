import pino, { type Logger } from "pino";

export type WorkerLogger = Logger;

export function createLogger(opts: { level?: string; name?: string } = {}): WorkerLogger {
  return pino({
    name: opts.name ?? "wazir-worker",
    level: opts.level ?? process.env.WAZIR_LOG_LEVEL ?? "info",
    redact: {
      paths: ["*.token", "*.secret", "*.password", "*.authorization"],
      censor: "[REDACTED]",
    },
  });
}
