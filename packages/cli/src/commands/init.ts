import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Telegraf, type Context } from "telegraf";
import prompts from "prompts";
import { generateHmacSecret } from "@wazir/protocol";
import {
  WAZIR_DIR,
  CONFIG_PATH,
  HOOK_SNIPPET_PATH,
  DEFAULT_DB_PATH,
  ENV_FILE_PATH,
} from "../paths.js";
import { defaultConfig, writeConfig } from "../config.js";

interface InitAnswers {
  workerId: string;
  hubPort: number;
  workerPort: number;
  telegramToken: string;
  allowlist: number[];
}

const TOKEN_SHAPE = /^\d{8,}:[A-Za-z0-9_-]{30,}$/;

export async function runInit(opts: { force?: boolean } = {}): Promise<void> {
  console.log("Wazir init wizard. This will create ~/.wazir/config.yaml.\n");

  if (existsSync(CONFIG_PATH) && !opts.force) {
    const { overwrite } = await prompts({
      type: "confirm",
      name: "overwrite",
      message: `Config already exists at ${CONFIG_PATH}. Overwrite?`,
      initial: false,
    });
    if (!overwrite) {
      console.log("Aborting.");
      return;
    }
  }

  mkdirSync(WAZIR_DIR, { recursive: true });

  const answers = (await prompts(
    [
      {
        type: "text",
        name: "workerId",
        message: "Worker ID (short name for this machine):",
        initial: defaultWorkerId(),
        validate: (v: string) => (/^[a-zA-Z0-9_-]{1,64}$/.test(v) ? true : "letters, digits, _, - only"),
      },
      {
        type: "number",
        name: "hubPort",
        message: "Hub bind port:",
        initial: 7842,
      },
      {
        type: "number",
        name: "workerPort",
        message: "Worker bind port:",
        initial: 7843,
      },
      {
        type: "password",
        name: "telegramToken",
        message:
          "Telegram bot token (paste from @BotFather; leave blank to skip):",
      },
    ],
    { onCancel: () => process.exit(1) },
  )) as Partial<InitAnswers>;

  if (!answers.workerId || !answers.hubPort || !answers.workerPort) {
    console.error("missing required answers; aborting.");
    return;
  }

  const telegramToken = (answers.telegramToken ?? "").trim();
  let allowlist: number[] = [];

  if (telegramToken) {
    if (!TOKEN_SHAPE.test(telegramToken)) {
      console.warn("warning: token does not match the Telegram token shape; storing anyway.");
    }
    writeEnvVar(ENV_FILE_PATH, "WAZIR_TELEGRAM_TOKEN", telegramToken);
    console.log(`wrote WAZIR_TELEGRAM_TOKEN to ${ENV_FILE_PATH}`);

    allowlist = await captureAllowlist(telegramToken);
  } else {
    console.log("skipping Telegram setup. You'll need to fill in adapters[0].config.allowlist later.");
  }

  const hmacSecret = generateHmacSecret();
  writeEnvVar(ENV_FILE_PATH, "WAZIR_HMAC_SECRET", hmacSecret);
  console.log(`wrote WAZIR_HMAC_SECRET to ${ENV_FILE_PATH}`);

  const config = defaultConfig({
    workerId: answers.workerId,
    hubPort: answers.hubPort,
    workerPort: answers.workerPort,
    dbPath: DEFAULT_DB_PATH,
    allowlist,
  });
  writeConfig(config, CONFIG_PATH);
  console.log(`wrote ${CONFIG_PATH}`);

  writeHookSnippet(answers.workerPort);
  console.log(`wrote ${HOOK_SNIPPET_PATH}`);

  console.log("\n✅ Done.\n");
  console.log("Next steps:");
  console.log("  1. Open ~/.claude/settings.json (or your repo's .claude/settings.json).");
  console.log(`  2. Merge the contents of ${HOOK_SNIPPET_PATH} into the "hooks" section.`);
  console.log("  3. In one terminal: wazir hub");
  console.log("  4. In another terminal: wazir worker");
  console.log("  5. Start Claude Code and ask it to run something risky (e.g. `git push`).");
}

async function captureAllowlist(token: string): Promise<number[]> {
  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message:
      "Now I'll listen for a message from your bot. Open Telegram, find your bot, send any message, then press Enter (or N to skip).",
    initial: true,
  });
  if (!proceed) return [];

  const bot = new Telegraf(token);
  return new Promise<number[]>((resolve) => {
    const collected = new Set<number>();
    const timeoutMs = 120_000;
    const timer = setTimeout(() => {
      console.warn("no message received in 2 minutes; allowlist left empty.");
      bot.stop();
      resolve([...collected]);
    }, timeoutMs);

    bot.on("message", async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      if (typeof chatId !== "number") return;
      if (!collected.has(chatId)) {
        collected.add(chatId);
        console.log(
          `received from chat_id=${chatId} (${ctx.from?.username ?? ctx.from?.first_name ?? "user"})`,
        );
        try {
          await ctx.reply(
            `Wazir: added ${chatId} to the allowlist. You can close this and finish init.`,
          );
        } catch {
          /* ignore */
        }
      }
      const followUp = await prompts({
        type: "confirm",
        name: "more",
        message: "Add another allowed chat (e.g. a second device)?",
        initial: false,
      });
      if (!followUp.more) {
        clearTimeout(timer);
        bot.stop();
        resolve([...collected]);
      }
    });

    bot.launch().catch((err: unknown) => {
      clearTimeout(timer);
      console.error("failed to launch listener bot:", (err as Error).message);
      resolve([]);
    });
  });
}

function defaultWorkerId(): string {
  const host = process.env.HOSTNAME ?? process.env.HOST ?? "machine";
  return host.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
}

function writeHookSnippet(workerPort: number): void {
  const snippet = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:${workerPort}/v1/hooks/claude-code/pre-tool-use`,
              timeout_seconds: 540,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(HOOK_SNIPPET_PATH, JSON.stringify(snippet, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function writeEnvVar(path: string, key: string, value: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const line = `${key}=${value}\n`;
  if (existsSync(path)) {
    appendFileSync(path, line, { encoding: "utf8" });
  } else {
    writeFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  }
}

