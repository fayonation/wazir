import type { InterfaceAdapter, WazirConfig } from "@wazir/protocol";
import { CliAdapter } from "@wazir/adapter-cli";
import { TelegramAdapter } from "@wazir/adapter-telegram";
import { resolveTelegramToken } from "./secrets.js";
import { KEYCHAIN_TELEGRAM_ACCOUNT } from "./paths.js";

export interface AdapterBuildContext {
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  forceCli?: boolean;
}

export async function buildAdapters(
  config: WazirConfig,
  ctx: AdapterBuildContext = {},
): Promise<InterfaceAdapter[]> {
  const adapters: InterfaceAdapter[] = [];
  for (const a of config.adapters) {
    if (!a.enabled && !(ctx.forceCli && a.name === "cli")) continue;
    if (a.name === "telegram") {
      const token = await resolveTelegramToken(
        a.config.token_env,
        Boolean(a.config.token_keychain_account),
        a.config.token_keychain_account ?? KEYCHAIN_TELEGRAM_ACCOUNT,
      );
      if (!token) {
        ctx.logger?.warn(
          `telegram adapter enabled but no token found (env=${a.config.token_env}). Skipping.`,
        );
        continue;
      }
      if (a.config.allowlist.length === 0) {
        ctx.logger?.warn("telegram adapter has empty allowlist; messages will not be delivered");
      }
      adapters.push(
        new TelegramAdapter({
          token,
          allowlist: a.config.allowlist,
          maxCommandChars: a.config.max_command_chars,
          defaultCwd: process.env.HOME ?? "/",
          logger: ctx.logger,
        }),
      );
    } else if (a.name === "cli") {
      adapters.push(new CliAdapter());
    }
  }
  return adapters;
}
