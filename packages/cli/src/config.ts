import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import {
  WazirConfigSchema,
  DEFAULT_RISK_PATTERNS,
  type WazirConfig,
} from "@wazir/protocol";
import { CONFIG_PATH } from "./paths.js";

export function loadConfig(path = CONFIG_PATH): WazirConfig {
  if (!existsSync(path)) {
    throw new Error(
      `no config at ${path}. Run 'pnpm init' (or 'wazir init') to create one.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw);
  const result = WazirConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid config at ${path}:\n${issues}`);
  }
  return result.data;
}

export function writeConfig(config: WazirConfig, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const yaml = YAML.stringify(config, { lineWidth: 120 });
  writeFileSync(path, yaml, { encoding: "utf8", mode: 0o600 });
}

export function defaultConfig(input: {
  workerId: string;
  hubPort: number;
  workerPort: number;
  dbPath: string;
  allowlist?: number[];
  telegramTokenEnv?: string;
}): WazirConfig {
  return {
    version: 1,
    worker: {
      id: input.workerId,
      bind_host: "127.0.0.1",
      bind_port: input.workerPort,
    },
    hub: {
      bind_host: "127.0.0.1",
      bind_port: input.hubPort,
      db_path: input.dbPath,
    },
    adapters: [
      {
        name: "telegram",
        enabled: true,
        config: {
          token_env: input.telegramTokenEnv ?? "WAZIR_TELEGRAM_TOKEN",
          allowlist: input.allowlist ?? [],
          use_inline_buttons: true,
          max_command_chars: 1200,
          chat_enabled: false,
        },
      },
      {
        name: "cli",
        enabled: false,
        config: {},
      },
    ],
    risk_patterns: DEFAULT_RISK_PATTERNS,
    repos: [],
    logging: { level: "info", rotate: "daily" },
  };
}
