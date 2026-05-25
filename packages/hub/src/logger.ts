import pino, { type Logger } from "pino";

export type HubLogger = Logger;

const TOKEN_REDACT_PATTERN = /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g;

function redactString(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return input.replace(TOKEN_REDACT_PATTERN, "[REDACTED_TOKEN]");
}

export function createLogger(opts: { level?: string; name?: string } = {}): HubLogger {
  return pino({
    name: opts.name ?? "wazir-hub",
    level: opts.level ?? process.env.WAZIR_LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "*.token",
        "*.secret",
        "*.password",
        "*.authorization",
        "req.headers.authorization",
        "req.headers[\"x-wazir-signature\"]",
      ],
      censor: "[REDACTED]",
    },
    formatters: {
      log(obj) {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          next[k] = redactString(v);
        }
        return next;
      },
    },
  });
}
