import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Message } from "telegraf/types";
import type {
  AdapterHandlers,
  DiscoveredSession,
  HubNotification,
  InterfaceAdapter,
  Session,
  SessionService,
  UserDecision,
} from "@wazir/protocol";

/** A unified entry in the chat's /list view — either a live tmux session or an on-disk session. */
interface ListEntry {
  kind: "tracked" | "discovered";
  session_id: string;
  agent: string;
  cwd: string;
  /** Wazir-set name (settable via /rename in Telegram). */
  label?: string;
  /** Claude Code's user-set title (via its own /rename inside the TUI). */
  agent_title?: string;
  /** Claude Code's auto-generated AI title. */
  ai_title?: string;
  /** First user message in the JSONL, shown as the snippet. */
  first_message?: string;
  message_count?: number;
  last_activity_at: number;
  /** Only set for tracked entries. */
  status?: string;
}

export interface TelegramAdapterOptions {
  token: string;
  allowlist: number[];
  maxCommandChars?: number;
  /** Fallback cwd when a chat has no sticky_cwd set yet. Defaults to $HOME. */
  defaultCwd?: string;
  /**
   * Polling cadence (ms) for "wait until the agent stops typing" after we
   * deliver input. Smaller = lower latency / more captures; larger = lighter
   * load on tmux. Default 1500 ms.
   */
  pollIntervalMs?: number;
  /**
   * How many consecutive identical polls before we consider the agent done
   * responding. Default 2 (so a stable pane for ~3s = done).
   */
  stableTicks?: number;
  /** Maximum total time (ms) to wait for the agent to settle. Default 45 s. */
  maxWaitMs?: number;
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

const HELP_TEXT = `*Wazir commands*
\`/new [agent]\` — spawn a session (default: claude)
\`/list\` — list all sessions (tracked + on-disk)
\`/resume <n|id>\` — switch active session (resumes from disk if needed)
\`/rename <n|id> <name>\` — name a session (empty name to clear)
\`/cwd <path>\` — set this chat's sticky cwd
\`/end\` — kill the active session
\`/voice on|off|auto\` — voice reply mode (placeholder until TTS lands)
\`/capture\` — re-read the active session's pane
\`/whoami\` — show your Telegram ids
Any plain text → typed into the active session.`;

export class TelegramAdapter implements InterfaceAdapter {
  readonly name = "telegram";

  private bot: Telegraf;
  private handlers: AdapterHandlers | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly modifyContext = new Map<string, string>(); // `${chatId}:${userId}` -> approvalId
  private readonly lastListByChat = new Map<number, string[]>(); // chatId -> ordered session_ids
  private readonly allowlist: Set<number>;
  private readonly maxCommandChars: number;
  private readonly defaultCwd: string;
  private readonly pollIntervalMs: number;
  private readonly stableTicks: number;
  private readonly maxWaitMs: number;
  private readonly logger: NonNullable<TelegramAdapterOptions["logger"]>;

  constructor(opts: TelegramAdapterOptions) {
    this.allowlist = new Set(opts.allowlist);
    this.maxCommandChars = opts.maxCommandChars ?? 1200;
    this.defaultCwd = opts.defaultCwd ?? process.env.HOME ?? "/";
    this.pollIntervalMs = opts.pollIntervalMs ?? 1500;
    this.stableTicks = opts.stableTicks ?? 2;
    this.maxWaitMs = opts.maxWaitMs ?? 45_000;
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
      await ctx.reply(`Wazir bot online.\nchat_id: ${ctx.chat.id}\nuser_id: ${ctx.from.id}`);
      await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
    });

    this.bot.command("whoami", async (ctx) => {
      await ctx.reply(`chat_id: ${ctx.chat.id}\nuser_id: ${ctx.from.id}`);
    });

    this.bot.command("new", async (ctx) => this.cmdNew(ctx));
    this.bot.command("list", async (ctx) => this.cmdList(ctx));
    this.bot.command("resume", async (ctx) => this.cmdResume(ctx));
    this.bot.command("rename", async (ctx) => this.cmdRename(ctx));
    this.bot.command("cwd", async (ctx) => this.cmdCwd(ctx));
    this.bot.command("end", async (ctx) => this.cmdEnd(ctx));
    this.bot.command("voice", async (ctx) => this.cmdVoice(ctx));
    this.bot.command("capture", async (ctx) => this.cmdCapture(ctx));

    this.bot.on("callback_query", async (ctx) => this.onCallback(ctx));

    this.bot.on("text", async (ctx) => this.onText(ctx));

    await this.bot.telegram.getMe();
    this.bot.launch().catch((err: unknown) => this.logger.error({ err }, "telegram launch error"));
    this.logger.info("telegram adapter started");
  }

  async sendNotification(n: HubNotification): Promise<void> {
    const command = extractCommand(n.body);
    const text = formatApprovalMessage(n, command, this.maxCommandChars);
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
        this.pending.set(n.approval_id, { notification: n, chatId, messageId: msg.message_id });
        return;
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
    this.lastListByChat.clear();
  }

  // ----------------------------------------------------------------
  // command handlers
  // ----------------------------------------------------------------

  private async cmdNew(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const args = parseArgs(ctx);
    const agent = args[0] ?? "claude";
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const chatState = await sessions.getChatState("telegram", String(chatId));
    const cwd = chatState?.sticky_cwd ?? this.defaultCwd;
    try {
      const session = await sessions.spawnSession({ agent, cwd });
      await sessions.setChatState("telegram", String(chatId), {
        active_session_id: session.session_id,
        sticky_cwd: cwd,
      });
      await ctx.reply(
        `✓ spawned \`${session.session_id.slice(0, 8)}\` (${session.agent}) in \`${session.cwd}\`\nActive session set.`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.reply(`error: ${(err as Error).message}`);
    }
  }

  private async cmdList(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const [tracked, discovered] = await Promise.all([
      sessions.listSessions(),
      sessions.listDiscoveredSessions(),
    ]);
    const allEntries = mergeListEntries(tracked, discovered);
    if (allEntries.length === 0) {
      await ctx.reply("(no sessions — start one with /new)");
      this.lastListByChat.delete(chatId);
      return;
    }
    const LIST_LIMIT = 15;
    const entries = allEntries.slice(0, LIST_LIMIT);
    const truncated = allEntries.length > LIST_LIMIT;
    const chatState = await sessions.getChatState("telegram", String(chatId));
    const activeId = chatState?.active_session_id ?? null;
    // Track ALL ids so /resume <n> still maps correctly even past the visible cap
    this.lastListByChat.set(chatId, allEntries.map((e) => e.session_id));

    const blocks: string[] = [];
    for (const [i, e] of entries.entries()) {
      const isActive = e.session_id === activeId;
      const marker = isActive ? "★" : e.kind === "tracked" ? "🟢" : "⚪";
      const { text: titleText, source } = resolveTitle(e);
      const titleSuffix =
        source === "claude-custom" ? " <i>· claude /rename</i>" :
        source === "claude-ai" ? " <i>· auto</i>" :
        "";
      const snippet = e.first_message ? `<i>"${escapeHtml(truncate(e.first_message, 70))}"</i>` : "";
      const recency = formatRelative(e.last_activity_at);
      const msgCount = e.message_count !== undefined ? `${e.message_count} msgs · ` : "";
      const statusBit = e.kind === "tracked" ? `${escapeHtml(e.status ?? "?")} · ` : "";
      const meta = `<code>${e.session_id.slice(0, 8)}</code> · ${statusBit}${msgCount}${recency} · ${escapeHtml(shortCwd(e.cwd))}`;
      const header = `${marker} <b>${i + 1}. ${escapeHtml(truncate(titleText, 60))}</b>${titleSuffix}`;
      const lines = [header];
      if (snippet) lines.push(`   ${snippet}`);
      lines.push(`   ${meta}`);
      blocks.push(lines.join("\n"));
    }

    const parts: string[] = [blocks.join("\n\n")];
    if (truncated) {
      parts.push(`\n…and ${allEntries.length - LIST_LIMIT} older. <i>/resume &lt;id-prefix&gt;</i> reaches them.`);
    }
    parts.push("\n★ active · 🟢 running · ⚪ available\n<i>/rename &lt;n&gt; &lt;name&gt;</i> to set a Wazir name");
    await this.safeReply(ctx, parts.join("\n"), { markdown: false, html: true });
  }

  private async cmdRename(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const text = (ctx.message as Message.TextMessage).text;
    const stripped = text.replace(/^\/rename(?:@\S+)?\s*/, "").trim();
    if (!stripped) {
      await ctx.reply("usage: /rename <n|id-prefix> <new name>\n(name can be empty to clear: /rename <n>)");
      return;
    }
    const firstSpace = stripped.indexOf(" ");
    const arg = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
    const rawName = firstSpace === -1 ? "" : stripped.slice(firstSpace + 1).trim();

    // Resolve target via list cache or full enumeration
    let targetId: string | undefined;
    const asNumber = Number.parseInt(arg, 10);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const cached = this.lastListByChat.get(chatId) ?? [];
      targetId = cached[asNumber - 1];
    }
    if (!targetId) {
      const [tracked, discovered] = await Promise.all([
        sessions.listSessions(),
        sessions.listDiscoveredSessions(),
      ]);
      const all = [...tracked.map((s) => s.session_id), ...discovered.map((d) => d.session_id)];
      targetId = all.find((id) => id.startsWith(arg));
    }
    if (!targetId) {
      await ctx.reply(`no session matches '${arg}' (try /list first)`);
      return;
    }
    try {
      await sessions.setSessionLabel(targetId, rawName);
      const verb = rawName ? `named '${rawName}'` : "cleared";
      await ctx.reply(`✓ ${targetId.slice(0, 8)} ${verb}`);
    } catch (err) {
      await ctx.reply(`rename failed: ${(err as Error).message}`);
    }
  }

  /**
   * Reply that gracefully falls back to plain text if Telegram rejects the
   * Markdown / HTML parse. Long messages get sliced into chunks under the
   * 4096 cap (we use 3500 for headroom).
   */
  private async safeReply(
    ctx: Context,
    body: string,
    opts: { markdown?: boolean; html?: boolean } = {},
  ): Promise<void> {
    const wantMd = opts.markdown ?? false;
    const wantHtml = opts.html ?? false;
    const MAX = 3500;
    const chunks: string[] = [];
    let i = 0;
    while (i < body.length) {
      let end = Math.min(i + MAX, body.length);
      if (end < body.length) {
        const nl = body.lastIndexOf("\n\n", end);
        const nlSingle = body.lastIndexOf("\n", end);
        const best = nl > i + MAX / 2 ? nl : nlSingle > i + MAX / 2 ? nlSingle : end;
        end = best;
      }
      chunks.push(body.slice(i, end));
      i = end;
      while (body[i] === "\n") i++;
    }
    for (const chunk of chunks) {
      try {
        if (wantHtml) {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } else if (wantMd) {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } else {
          await ctx.reply(chunk);
        }
      } catch (err) {
        this.logger.warn({ err }, "telegram reply failed; retrying as plain text");
        try {
          // Strip HTML tags before plain fallback so users don't see raw markup
          const plain = chunk.replace(/<[^>]+>/g, "");
          await ctx.reply(plain);
        } catch (err2) {
          this.logger.error({ err: err2 }, "telegram reply plain-text fallback also failed");
        }
      }
    }
  }

  private async cmdResume(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const args = parseArgs(ctx);
    const arg = args[0];
    if (!arg) {
      await ctx.reply("usage: `/resume <list-number | session-id-prefix>`", { parse_mode: "Markdown" });
      return;
    }

    const [tracked, discovered] = await Promise.all([
      sessions.listSessions(),
      sessions.listDiscoveredSessions(),
    ]);
    const entries = mergeListEntries(tracked, discovered);

    let chosen: ListEntry | undefined;
    const asNumber = Number.parseInt(arg, 10);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const ordered = this.lastListByChat.get(chatId) ?? entries.map((e) => e.session_id);
      const id = ordered[asNumber - 1];
      if (id) chosen = entries.find((e) => e.session_id === id);
    }
    if (!chosen) chosen = entries.find((e) => e.session_id.startsWith(arg));

    if (!chosen) {
      await ctx.reply(`no session matches \`${arg}\` (try /list)`, { parse_mode: "Markdown" });
      return;
    }

    let trackedSession: Session;
    let resumedFromDisk = false;
    if (chosen.kind === "tracked") {
      const found = tracked.find((s) => s.session_id === chosen!.session_id);
      if (!found) {
        await ctx.reply("internal error: tracked session vanished between list and resume");
        return;
      }
      trackedSession = found;
    } else {
      try {
        trackedSession = await sessions.resumeDiscoveredSession(chosen.session_id);
        resumedFromDisk = true;
      } catch (err) {
        await ctx.reply(`resume failed: ${(err as Error).message}`);
        return;
      }
    }

    await sessions.setChatState("telegram", String(chatId), {
      active_session_id: trackedSession.session_id,
      sticky_cwd: trackedSession.cwd,
    });

    const summary = await this.formatResumeSummary(sessions, trackedSession, resumedFromDisk);
    await ctx.reply(summary, { parse_mode: "Markdown" });
  }

  private async formatResumeSummary(
    sessions: SessionService,
    session: Session,
    resumedFromDisk: boolean,
  ): Promise<string> {
    const id = session.session_id.slice(0, 8);
    const header = resumedFromDisk
      ? `★ resumed \`${id}\` (${session.agent}) in \`${session.cwd}\``
      : `★ active = \`${id}\` (${session.agent}, ${session.status})`;
    const meta = await sessions.getDiscoveredSession(session.session_id);
    if (!meta) return header;
    const parts: string[] = [header];
    if (meta.first_message) parts.push(`*Started:* ${escapeMd(truncate(meta.first_message, 240))}`);
    if (meta.last_assistant) parts.push(`*Last:* ${escapeMd(truncate(meta.last_assistant, 240))}`);
    if (meta.message_count > 0) parts.push(`_${meta.message_count} messages · last activity ${formatRelative(meta.last_activity_at)}_`);
    return parts.join("\n");
  }

  private async cmdCwd(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const text = (ctx.message as Message.TextMessage).text;
    const path = text.replace(/^\/cwd(?:@\S+)?\s*/, "").trim();
    if (!path) {
      const state = await sessions.getChatState("telegram", String(chatId));
      await ctx.reply(
        `current sticky cwd: \`${state?.sticky_cwd ?? this.defaultCwd + " (default)"}\``,
        { parse_mode: "Markdown" },
      );
      return;
    }
    await sessions.setChatState("telegram", String(chatId), { sticky_cwd: path });
    await ctx.reply(`✓ sticky cwd set to \`${path}\``, { parse_mode: "Markdown" });
  }

  private async cmdEnd(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = await sessions.getChatState("telegram", String(chatId));
    if (!state?.active_session_id) {
      await ctx.reply("no active session.");
      return;
    }
    const ok = await sessions.killSession(state.active_session_id);
    await sessions.setChatState("telegram", String(chatId), { active_session_id: null });
    await ctx.reply(ok ? `✓ ended \`${state.active_session_id.slice(0, 8)}\`` : "(already gone)", {
      parse_mode: "Markdown",
    });
  }

  private async cmdVoice(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const args = parseArgs(ctx);
    const mode = args[0]?.toLowerCase();
    if (mode !== "on" && mode !== "off" && mode !== "auto") {
      const state = await sessions.getChatState("telegram", String(chatId));
      await ctx.reply(`voice mode: ${state?.voice_mode ?? "auto"} (set with /voice on|off|auto)`);
      return;
    }
    await sessions.setChatState("telegram", String(chatId), { voice_mode: mode });
    await ctx.reply(`✓ voice mode = ${mode} (TTS ships in a follow-up commit)`);
  }

  private async cmdCapture(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = await sessions.getChatState("telegram", String(chatId));
    if (!state?.active_session_id) {
      await ctx.reply("no active session.");
      return;
    }
    try {
      const cap = await sessions.capturePane(state.active_session_id, { visibleOnly: true });
      await ctx.reply(this.formatPaneOutput(cap.text), { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`capture failed: ${(err as Error).message}`);
    }
  }

  // ----------------------------------------------------------------
  // event handlers
  // ----------------------------------------------------------------

  private async onCallback(ctx: Context): Promise<void> {
    const data = (ctx.callbackQuery as { data?: string } | undefined)?.data;
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
      await this.handlers?.onDecision(approvalId, { action: verb, actor } as UserDecision);
      return;
    }
    if (verb === "modify") {
      await ctx.answerCbQuery("send the replacement command as a reply");
      this.modifyContext.set(this.modifyKey(chatId, userId), approvalId);
      pending.awaitingModifyFrom = userId;
      await ctx.reply(`Reply with the modified command for approval \`${approvalId.slice(0, 8)}\`:`, {
        parse_mode: "Markdown",
      });
      return;
    }
    await ctx.answerCbQuery("unknown action");
  }

  private async onText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || chatId === undefined) return;
    const text = (ctx.message as Message.TextMessage).text;
    if (!text || text.startsWith("/")) return;

    // 1) modify-approval flow takes precedence
    const modifyKey = this.modifyKey(chatId, userId);
    const approvalId = this.modifyContext.get(modifyKey);
    if (approvalId) {
      const pending = this.pending.get(approvalId);
      if (!pending) {
        this.modifyContext.delete(modifyKey);
        return;
      }
      this.modifyContext.delete(modifyKey);
      this.pending.delete(approvalId);
      await this.editApprovalMessage(pending, `✏️ Modified → \`${truncate(text, 200)}\``);
      await this.handlers?.onDecision(approvalId, {
        action: "modify",
        actor: `telegram:user_id=${userId}`,
        modified_command: text,
      });
      return;
    }

    // 2) otherwise route to the active session
    const sessions = this.handlers?.sessions;
    if (!sessions) {
      await ctx.reply("(no session service available — hub not wired)");
      return;
    }
    const state = await sessions.getChatState("telegram", String(chatId));
    if (!state?.active_session_id) {
      await ctx.reply("no active session — try /new claude (or /list then /resume).");
      return;
    }
    try {
      await sessions.sendInput(state.active_session_id, text);
    } catch (err) {
      await ctx.reply(`send failed: ${(err as Error).message}`);
      return;
    }
    // Keep "typing..." showing in Telegram while the agent works.
    // sendChatAction expires after ~5s, so refresh every 4s until done.
    const startTyping = () => {
      void ctx.telegram.sendChatAction(chatId, "typing").catch(() => {});
    };
    startTyping();
    const typingTimer = setInterval(startTyping, 4000);
    typingTimer.unref?.();

    try {
      const final = await this.waitForStablePane(sessions, state.active_session_id);
      if (final.trim().length === 0) {
        await ctx.reply("(no output captured — the pane is empty)");
        return;
      }
      await ctx.reply(this.formatPaneOutput(final), { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`(could not capture response: ${(err as Error).message})`);
    } finally {
      clearInterval(typingTimer);
    }
  }

  /**
   * Poll the session's visible pane until two consecutive captures are
   * byte-identical, then return that snapshot. Caps at maxWaitMs.
   */
  private async waitForStablePane(
    sessions: SessionService,
    sessionId: string,
  ): Promise<string> {
    const start = Date.now();
    let previous: string | null = null;
    let stableCount = 0;
    let lastSeen = "";
    while (Date.now() - start < this.maxWaitMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      let cap;
      try {
        cap = await sessions.capturePane(sessionId, { visibleOnly: true });
      } catch (err) {
        this.logger.warn({ err, sessionId }, "capture during poll failed");
        continue;
      }
      lastSeen = cap.text;
      if (cap.text === previous) {
        stableCount += 1;
        if (stableCount >= this.stableTicks) return cap.text;
      } else {
        previous = cap.text;
        stableCount = 0;
      }
    }
    // Timed out — return whatever we last saw so the user gets something useful.
    return lastSeen;
  }

  // ----------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------

  private requireSessionService(ctx: Context): SessionService | null {
    const svc = this.handlers?.sessions;
    if (!svc) {
      void ctx.reply("(session service unavailable — hub not wired up for sessions)");
      return null;
    }
    return svc;
  }

  private modifyKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  private async editApprovalMessage(pending: PendingApproval, status: string): Promise<void> {
    const original = formatApprovalMessage(pending.notification, extractCommand(pending.notification.body), this.maxCommandChars);
    const text = `${original}\n\n*${status}*`;
    try {
      await this.bot.telegram.editMessageText(pending.chatId, pending.messageId, undefined, text, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      this.logger.warn({ err, approval_id: pending.notification.approval_id }, "telegram edit failed");
    }
  }

  private formatPaneOutput(text: string): string {
    const trimmed = text.replace(/\s+$/g, "");
    // collapse runs of >2 blank lines so terminal whitespace doesn't dominate
    const collapsed = trimmed.replace(/\n{3,}/g, "\n\n");
    const max = 3500;
    const body = collapsed.length > max ? `…\n${collapsed.slice(-max)}` : collapsed;
    return "```\n" + body + "\n```";
  }
}

function mergeListEntries(
  tracked: Session[],
  discovered: DiscoveredSession[],
): ListEntry[] {
  const seen = new Set<string>();
  const entries: ListEntry[] = [];
  // Tracked rows take precedence — but they don't carry first_message,
  // so we try to pull it from the discovered list for the same id.
  const discoveredById = new Map<string, DiscoveredSession>();
  for (const d of discovered) discoveredById.set(d.session_id, d);

  for (const s of tracked) {
    seen.add(s.session_id);
    const fromDisk = discoveredById.get(s.session_id);
    const entry: ListEntry = {
      kind: "tracked",
      session_id: s.session_id,
      agent: s.agent,
      cwd: s.cwd,
      last_activity_at: s.last_activity_at,
      status: s.status,
    };
    if (s.label !== undefined) entry.label = s.label;
    if (fromDisk?.first_message !== undefined) entry.first_message = fromDisk.first_message;
    if (fromDisk?.agent_title !== undefined) entry.agent_title = fromDisk.agent_title;
    if (fromDisk?.ai_title !== undefined) entry.ai_title = fromDisk.ai_title;
    if (s.message_count !== undefined) entry.message_count = s.message_count;
    else if (fromDisk?.message_count !== undefined) entry.message_count = fromDisk.message_count;
    entries.push(entry);
  }
  for (const d of discovered) {
    if (seen.has(d.session_id)) continue;
    const entry: ListEntry = {
      kind: "discovered",
      session_id: d.session_id,
      agent: d.agent,
      cwd: d.cwd,
      last_activity_at: d.last_activity_at,
      message_count: d.message_count,
    };
    if (d.label !== undefined) entry.label = d.label;
    if (d.agent_title !== undefined) entry.agent_title = d.agent_title;
    if (d.ai_title !== undefined) entry.ai_title = d.ai_title;
    if (d.first_message !== undefined) entry.first_message = d.first_message;
    entries.push(entry);
  }
  entries.sort((a, b) => b.last_activity_at - a.last_activity_at);
  return entries;
}

/** Pick the most user-meaningful title for a session, with a clear precedence. */
function resolveTitle(e: ListEntry): { text: string; source: "wazir" | "claude-custom" | "claude-ai" | "fallback" } {
  if (e.label) return { text: e.label, source: "wazir" };
  if (e.agent_title) return { text: e.agent_title, source: "claude-custom" };
  if (e.ai_title) return { text: e.ai_title, source: "claude-ai" };
  return { text: "(unnamed)", source: "fallback" };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

function parseArgs(ctx: Context): string[] {
  const text = (ctx.message as Message.TextMessage | undefined)?.text ?? "";
  const parts = text.split(/\s+/);
  return parts.slice(1);
}

function extractCommand(body: string): string {
  const lines = body.split("\n");
  return lines[0] ?? body;
}

function formatApprovalMessage(n: HubNotification, command: string, maxChars: number): string {
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
