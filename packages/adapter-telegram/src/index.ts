import { Telegraf, Markup } from "telegraf";
import type { Message } from "telegraf/types";
import type {
  AdapterHandlers,
  HubNotification,
  InterfaceAdapter,
  UserDecision,
} from "@wazir/protocol";

export interface TelegramAdapterOptions {
  token: string;
  allowlist: number[];
  maxCommandChars?: number;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

interface PendingApproval {
  notification: HubNotification;
  chatId: number;
  messageId: number;
  awaitingModifyFrom?: number;
}

const NOOP_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class TelegramAdapter implements InterfaceAdapter {
  readonly name = "telegram";

  private bot: Telegraf;
  private handlers: AdapterHandlers | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly modifyContext = new Map<string, string>(); // key: `${chatId}:${userId}` -> approvalId
  private readonly allowlist: Set<number>;
  private readonly maxCommandChars: number;
  private readonly logger: NonNullable<TelegramAdapterOptions["logger"]>;

  constructor(opts: TelegramAdapterOptions) {
    this.allowlist = new Set(opts.allowlist);
    this.maxCommandChars = opts.maxCommandChars ?? 1200;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.bot = new Telegraf(opts.token);
    this.bot.catch((err, ctx) => {
      this.logger.error({ err, update_type: ctx.updateType }, "telegram bot error");
    });
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId === undefined || !this.allowlist.has(userId)) {
        this.logger.warn({ user_id: userId, chat_id: ctx.chat?.id }, "telegram: rejected non-allowlisted sender");
        return;
      }
      await next();
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        `Wazir bot online.\nchat_id: ${ctx.chat.id}\nuser_id: ${ctx.from.id}\nYou are on the allowlist.`,
      );
    });

    this.bot.command("whoami", async (ctx) => {
      await ctx.reply(`chat_id: ${ctx.chat.id}\nuser_id: ${ctx.from.id}`);
    });

    this.bot.on("callback_query", async (ctx) => {
      const data = (ctx.callbackQuery as { data?: string }).data;
      if (!data) {
        await ctx.answerCbQuery();
        return;
      }
      const [verb, approvalId] = data.split(":", 2);
      if (!verb || !approvalId) {
        await ctx.answerCbQuery("malformed");
        return;
      }
      const pending = this.pending.get(approvalId);
      if (!pending) {
        await ctx.answerCbQuery("expired");
        return;
      }
      const userId = ctx.from?.id ?? 0;
      const chatId = ctx.chat?.id ?? 0;
      const actor = `telegram:user_id=${userId}`;

      if (verb === "approve" || verb === "reject") {
        await ctx.answerCbQuery(verb === "approve" ? "approved" : "rejected");
        await this.editApprovalMessage(pending, verb === "approve" ? "✅ Approved" : "❌ Rejected");
        this.pending.delete(approvalId);
        await this.handlers?.onDecision(approvalId, {
          action: verb,
          actor,
        } as UserDecision);
        return;
      }
      if (verb === "modify") {
        await ctx.answerCbQuery("send the replacement command as a reply");
        this.modifyContext.set(this.modifyKey(chatId, userId), approvalId);
        pending.awaitingModifyFrom = userId;
        await ctx.reply(
          `Reply with the modified command for approval \`${approvalId.slice(0, 8)}\`:`,
          { parse_mode: "Markdown" },
        );
        return;
      }
      await ctx.answerCbQuery("unknown action");
    });

    this.bot.on("text", async (ctx) => {
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;
      const key = this.modifyKey(chatId, userId);
      const approvalId = this.modifyContext.get(key);
      if (!approvalId) return;
      const pending = this.pending.get(approvalId);
      if (!pending) {
        this.modifyContext.delete(key);
        return;
      }
      const text = (ctx.message as Message.TextMessage).text.trim();
      if (!text) return;
      this.modifyContext.delete(key);
      this.pending.delete(approvalId);
      await this.editApprovalMessage(pending, `✏️ Modified → \`${truncate(text, 200)}\``);
      await this.handlers?.onDecision(approvalId, {
        action: "modify",
        actor: `telegram:user_id=${userId}`,
        modified_command: text,
      });
    });

    await this.bot.telegram.getMe();
    this.bot.launch().catch((err) => this.logger.error({ err }, "telegram launch error"));
    this.logger.info("telegram adapter started");
  }

  async sendNotification(n: HubNotification): Promise<void> {
    const command = extractCommand(n.body);
    const text = formatMessage(n, command, this.maxCommandChars);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Approve", `approve:${n.approval_id}`),
        Markup.button.callback("❌ Reject", `reject:${n.approval_id}`),
        Markup.button.callback("✏️ Modify", `modify:${n.approval_id}`),
      ],
    ]);
    for (const chatId of this.allowlist) {
      try {
        const msg = await this.bot.telegram.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          ...keyboard,
        });
        this.pending.set(n.approval_id, {
          notification: n,
          chatId,
          messageId: msg.message_id,
        });
        return; // first allowlisted recipient wins
      } catch (err) {
        this.logger.warn({ err, chat_id: chatId }, "telegram send failed; trying next allowlist entry");
      }
    }
    throw new Error("telegram: no allowlist entry accepted the notification");
  }

  async cancelNotification(approvalId: string, reason: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    this.pending.delete(approvalId);
    await this.editApprovalMessage(pending, `⌛ ${reason}`);
  }

  async stop(): Promise<void> {
    this.bot.stop("SIGTERM");
    this.pending.clear();
    this.modifyContext.clear();
  }

  private modifyKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  private async editApprovalMessage(pending: PendingApproval, status: string): Promise<void> {
    const original = formatMessage(pending.notification, extractCommand(pending.notification.body), this.maxCommandChars);
    const text = `${original}\n\n*${status}*`;
    try {
      await this.bot.telegram.editMessageText(pending.chatId, pending.messageId, undefined, text, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      this.logger.warn({ err, approval_id: pending.notification.approval_id }, "telegram edit failed");
    }
  }
}

function extractCommand(body: string): string {
  const lines = body.split("\n");
  return lines[0] ?? body;
}

function formatMessage(n: HubNotification, command: string, maxChars: number): string {
  const truncated = truncate(command, maxChars);
  const ctx = n.context as { worker_id?: string; cwd?: string; model_label?: string; source?: string };
  const workerId = ctx.worker_id ?? "?";
  const cwd = ctx.cwd;
  const cwdLine = cwd ? `\n_@ ${escapeMd(workerId)} : ${escapeMd(cwd)}_` : `\n_@ ${escapeMd(workerId)}_`;
  const modelLine = ctx.model_label
    ? `\n_${escapeMd(ctx.source ?? "claude-code")} · ${escapeMd(ctx.model_label)}_`
    : "";
  return `*${escapeMd(n.title)}*\n\`\`\`\n${truncated}\n\`\`\`${cwdLine}${modelLine}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function escapeMd(s: string): string {
  return s.replace(/([_*`\[\]])/g, "\\$1");
}
