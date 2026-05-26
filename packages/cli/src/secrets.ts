import { readFileSync, existsSync } from "node:fs";
import { ENV_FILE_PATH } from "./paths.js";

/**
 * Wazir stores all secrets in `~/.wazir/.env`. We deliberately do not use the
 * macOS keychain or any other OS-specific secret store — see ADR-015. This
 * keeps the install self-contained and portable: copy `~/.wazir/` to any
 * machine and the daemons come up.
 *
 * The .env file is created with mode 0600 by `wazir init` and stays that way.
 */

export function loadDotEnv(path = ENV_FILE_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function mergeDotEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

export function resolveTelegramToken(envVarName: string): string | null {
  return process.env[envVarName] ?? null;
}

export function resolveHmacSecret(envVarName = "WAZIR_HMAC_SECRET"): string | null {
  return process.env[envVarName] ?? null;
}
