import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Message } from "telegraf/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
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
\`/resume <n|id> [force]\` — switch active session (resumes from disk if needed). Add \`force\` to override the "session looks active elsewhere" guard.
\`/switch <description>\` — fuzzy-match a session by free text (e.g. \`/switch auth refactor\`)
\`/rename <n|id> <name>\` — name a session (empty name to clear)
\`/cwd <path>\` — set this chat's sticky cwd
\`/end\` — kill the active session
\`/clear\` — wipe the active session's context (types /clear into the pane)
\`/voice on|off|auto\` — voice reply mode
\`/say <text>\` — speak arbitrary text as a voice note
\`/capture\` — re-read the active session's pane (text)
\`/screen\` — screenshot the active session's pane (image)
\`/whoami\` — show your Telegram ids
Any plain text → typed into the active session.`;

export class TelegramAdapter implements InterfaceAdapter {
  readonly name = "telegram";

  private bot: Telegraf;
  private handlers: AdapterHandlers | null = null;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly modifyContext = new Map<string, string>(); // `${chatId}:${userId}` -> approvalId
  private readonly lastListByChat = new Map<number, string[]>(); // chatId -> ordered session_ids
  // Per-session in-flight delivery; new messages chain off this so we don't
  // race two pollers on the same pane.
  private readonly inflightBySession = new Map<string, Promise<void>>();
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
    this.maxWaitMs = opts.maxWaitMs ?? 180_000;
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
    this.bot.command("switch", async (ctx) => this.cmdSwitch(ctx));
    this.bot.command("rename", async (ctx) => this.cmdRename(ctx));
    this.bot.command("cwd", async (ctx) => this.cmdCwd(ctx));
    this.bot.command("end", async (ctx) => this.cmdEnd(ctx));
    this.bot.command("voice", async (ctx) => this.cmdVoice(ctx));
    this.bot.command("say", async (ctx) => this.cmdSay(ctx));
    this.bot.command("capture", async (ctx) => this.cmdCapture(ctx));
    this.bot.command("screen", async (ctx) => this.cmdScreen(ctx));
    this.bot.command("clear", async (ctx) => this.cmdClearSession(ctx));

    this.bot.on("callback_query", async (ctx) => this.onCallback(ctx));

    this.bot.on("text", async (ctx) => this.onText(ctx));
    this.bot.on("voice", async (ctx) => this.onVoice(ctx));
    this.bot.on("audio", async (ctx) => this.onAudio(ctx));
    this.bot.on("photo", async (ctx) => this.onPhoto(ctx));
    this.bot.on("document", async (ctx) => this.onDocument(ctx));

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
    this.inflightBySession.clear();
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
      await ctx.reply("usage: `/resume <list-number | session-id-prefix> [force]`", { parse_mode: "Markdown" });
      return;
    }
    const force = (args[1] ?? "").toLowerCase() === "force";

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

    await this.applySessionSwitch(ctx, sessions, chatId, chosen, tracked, force);
  }

  /**
   * Make `entry` the active session for this chat. Handles the concurrency
   * guard for discovered sessions and posts the same /resume summary.
   * Shared by /resume and /switch.
   */
  private async applySessionSwitch(
    ctx: Context,
    sessions: SessionService,
    chatId: number,
    entry: ListEntry,
    tracked: Session[],
    force: boolean,
  ): Promise<void> {
    let trackedSession: Session;
    let resumedFromDisk = false;
    if (entry.kind === "tracked") {
      const found = tracked.find((s) => s.session_id === entry.session_id);
      if (!found) {
        await ctx.reply("internal error: tracked session vanished between list and resume");
        return;
      }
      trackedSession = found;
    } else {
      // Concurrency guard: a recently-modified JSONL is likely being written
      // to by another claude process (e.g. open terminal). Resuming would
      // give us two writers on the same file → corruption. Refuse unless
      // the user explicitly passes "force".
      if (!force) {
        const ageMs = Date.now() - entry.last_activity_at;
        if (ageMs < 60_000) {
          await ctx.reply(
            [
              `⚠️ Session \`${entry.session_id.slice(0, 8)}\` was touched ${Math.round(ageMs / 1000)}s ago — looks like it might still be active in another terminal.`,
              `Resuming now would create two writers on the same transcript file.`,
              ``,
              `If you're sure the other process is gone:`,
              `\`/resume ${entry.session_id.slice(0, 8)} force\``,
            ].join("\n"),
            { parse_mode: "Markdown" },
          );
          return;
        }
      }
      try {
        trackedSession = await sessions.resumeDiscoveredSession(entry.session_id);
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

  private async cmdSwitch(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const raw = (ctx.message as Message.TextMessage).text;
    const query = raw.replace(/^\/switch(?:@\S+)?\s*/, "").trim();
    if (!query) {
      await ctx.reply(
        "usage: `/switch <natural-language description>`\nexamples: `/switch auth refactor`, `/switch back to the redis migration`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const [tracked, discovered] = await Promise.all([
      sessions.listSessions(),
      sessions.listDiscoveredSessions(),
    ]);
    const entries = mergeListEntries(tracked, discovered);
    if (entries.length === 0) {
      await ctx.reply("(no sessions to switch to — /new to spawn one)");
      return;
    }

    const ranked = rankSessionsByQuery(query, entries);
    const best = ranked[0];

    // Decision: clear winner if its score is meaningfully ahead of the
    // runner-up. Otherwise show the top candidates and let the user
    // /resume the right one.
    const runnerUp = ranked[1];
    const clearWinner =
      best && best.score >= 2 && (!runnerUp || best.score >= runnerUp.score + 2);

    if (clearWinner) {
      await this.applySessionSwitch(ctx, sessions, chatId, best.entry, tracked, false);
      return;
    }

    const candidates = ranked.filter((r) => r.score > 0).slice(0, 3);
    if (candidates.length === 0) {
      await ctx.reply(
        `no sessions matched "${escapeMd(query)}". /list to see them all.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    const orderedIds = candidates.map((c) => c.entry.session_id);
    this.lastListByChat.set(chatId, orderedIds);

    const lines = [`Several matches for "${escapeMd(query)}" — pick one:`, ""];
    for (const [i, c] of candidates.entries()) {
      const { text: titleText } = resolveTitle(c.entry);
      const snippet = c.entry.first_message ? ` _"${escapeMd(truncate(c.entry.first_message, 60))}"_` : "";
      lines.push(`*${i + 1}.* ${escapeMd(truncate(titleText, 50))}${snippet}`);
      lines.push(`   \`/resume ${i + 1}\` · ${formatRelative(c.entry.last_activity_at)}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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
    const desc =
      mode === "on" ? "all replies as voice notes" :
      mode === "off" ? "all replies as text" :
      "voice for short replies, text for long";
    await ctx.reply(`✓ voice mode = ${mode} (${desc})`);
  }

  private async cmdSay(ctx: Context): Promise<void> {
    const sessions = this.requireSessionService(ctx);
    if (!sessions) return;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const raw = (ctx.message as Message.TextMessage).text;
    const text = raw.replace(/^\/say(?:@\S+)?\s*/, "").trim();
    if (!text) {
      await ctx.reply("usage: /say <text> — synthesizes the text as a voice note");
      return;
    }
    try {
      const audio = await sessions.synthesizeText(text);
      await ctx.telegram.sendVoice(chatId, { source: audio });
    } catch (err) {
      await ctx.reply(`tts failed: ${(err as Error).message}`);
    }
  }

  private async cmdClearSession(ctx: Context): Promise<void> {
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
      await sessions.sendInput(state.active_session_id, "/clear", true);
      await ctx.reply(`✓ sent /clear to ${state.active_session_id.slice(0, 8)} — context wiped, session_id kept`);
    } catch (err) {
      await ctx.reply(`clear failed: ${(err as Error).message}`);
    }
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
      const cleaned = cleanPaneText(cap.text);
      if (cleaned) {
        await this.safeReply(ctx, cleaned);
      } else {
        await ctx.reply("(pane is empty)");
      }
    } catch (err) {
      await ctx.reply(`capture failed: ${(err as Error).message}`);
    }
  }

  private async cmdScreen(ctx: Context): Promise<void> {
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
      // Get session label to show in the title bar of the screenshot.
      const discovered = await sessions.getDiscoveredSession(state.active_session_id).catch(() => null);
      const tracked = (await sessions.listSessions()).find((s) => s.session_id === state.active_session_id);
      const label = tracked?.label ?? discovered?.agent_title ?? discovered?.ai_title ?? state.active_session_id.slice(0, 8);
      const png = await sessions.screenshotPane(state.active_session_id, { label });
      await ctx.replyWithPhoto({ source: png });
    } catch (err) {
      await ctx.reply(`screenshot failed: ${(err as Error).message}`);
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
    await this.deliverPromptAndStream(ctx, sessions, state.active_session_id, text);
  }

  /**
   * Type `text` into a session's pane, hold a "typing..." indicator while the
   * agent works, then reply with the response when it settles.
   * Shared by `onText`, `onVoice`, and image handlers.
   *
   * Concurrency: deliveries are serialized per session. Two messages sent
   * back-to-back will run in order rather than racing two pollers on the
   * same pane (which used to cause Handler B to capture Handler A's
   * response and Handler B's actual response to be lost).
   *
   * Response priority:
   *   1. last_assistant from the JSONL (clean markdown text, no TUI chrome)
   *   2. cleaned visible pane output (fallback if JSONL isn't ready)
   */
  private async deliverPromptAndStream(
    ctx: Context,
    sessions: SessionService,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // CRITICAL: the read of `prev` and the set of `wrapped` MUST happen in one
    // synchronous block (no awaits between them). Otherwise two handlers can
    // both observe the same stale `prev` while waiting on an early await, and
    // chain off the same predecessor instead of forming a proper chain.
    const prev = this.inflightBySession.get(sessionId);

    const work = (async (): Promise<void> => {
      // 1. Immediate UI feedback. "Queued" if there's a predecessor, otherwise
      //    straight to "Working".
      let workingMsgId: number | null = null;
      try {
        const m = await ctx.reply(prev ? "⏳ Queued..." : "⏳ Working...");
        workingMsgId = m.message_id;
      } catch { /* non-fatal */ }

      // 2. Wait our turn.
      if (prev) {
        try { await prev; } catch { /* don't let predecessor failures block us */ }
        if (workingMsgId !== null) {
          try {
            await ctx.telegram.editMessageText(chatId, workingMsgId, undefined, "⏳ Working...");
          } catch { /* non-fatal */ }
        }
      }

      const deleteWorking = () => {
        if (workingMsgId !== null) {
          void ctx.telegram.deleteMessage(chatId, workingMsgId).catch(() => {});
          workingMsgId = null;
        }
      };

      // 3. Drive the session. Snapshot JSONL state BEFORE sending so we can
      // detect the new assistant turn by diffing message_count and
      // last_assistant against this baseline.
      const beforeMeta = await sessions.getDiscoveredSession(sessionId).catch(() => null);
      try {
        await sessions.sendInput(sessionId, text);
      } catch (err) {
        deleteWorking();
        const msg = (err as Error).message;
        if (msg.includes("unknown session")) {
          await ctx.reply(
            "Session unreachable — it was lost when the worker restarted.\n" +
            "Use /list then /resume to reconnect.",
          );
        } else {
          await ctx.reply(`Could not send message: ${msg}`);
        }
        return;
      }

      const typingTimer = setInterval(() => {
        void ctx.telegram.sendChatAction(chatId, "typing").catch(() => {});
      }, 4000);
      typingTimer.unref?.();

      try {
        // Primary signal: wait for a new assistant turn in the JSONL.
        // This is authoritative — JSONL is only written when Claude
        // completes a turn — so it sidesteps all the timing pitfalls of
        // polling the visible pane (status-bar gaps, input echo,
        // streaming pauses, etc.).
        const response = await this.waitForAssistantResponse(sessions, sessionId, beforeMeta);
        deleteWorking();
        if (response) {
          await this.deliverResponse(ctx, sessions, chatId, response);
        } else {
          // Fall back to pane scraping if JSONL never recorded a new
          // assistant message (e.g. session not yet in discovery, or
          // Claude is blocked on an approval).
          try {
            const cap = await sessions.capturePane(sessionId, { visibleOnly: true });
            const cleaned = cleanPaneText(cap.text);
            if (cleaned) {
              await this.deliverResponse(ctx, sessions, chatId, cleaned);
            } else {
              await ctx.reply("(no response detected within timeout — Claude may be blocked on a tool approval, or the session is idle)");
            }
          } catch (err) {
            await ctx.reply(`(could not capture response: ${(err as Error).message})`);
          }
        }
      } catch (err) {
        deleteWorking();
        await ctx.reply(`(delivery failed: ${(err as Error).message})`);
      } finally {
        clearInterval(typingTimer);
      }
    })();

    const wrapped = work.finally(() => {
      if (this.inflightBySession.get(sessionId) === wrapped) {
        this.inflightBySession.delete(sessionId);
      }
    });
    this.inflightBySession.set(sessionId, wrapped);
    await wrapped;
  }

  /**
   * Send a response text to the user. When voice mode is active, synthesizes
   * to an OGG/Opus voice note. Falls back to text if TTS fails or isn't installed.
   *
   *  off  → text only
   *  on   → voice note only
   *  auto → voice note if ≤ 400 chars (conversational), text otherwise
   */
  private async deliverResponse(
    ctx: Context,
    sessions: SessionService,
    chatId: number,
    text: string,
  ): Promise<void> {
    const state = await sessions.getChatState("telegram", String(chatId)).catch(() => null);
    const voiceMode = state?.voice_mode ?? "auto";
    const wantVoice = voiceMode === "on" || (voiceMode === "auto" && text.length <= 400);

    if (wantVoice) {
      try {
        const audio = await sessions.synthesizeText(text);
        await ctx.telegram.sendVoice(chatId, { source: audio });
        return;
      } catch (err) {
        this.logger.warn({ err }, "TTS failed; falling back to text reply");
      }
    }
    await this.safeReply(ctx, text);
  }

  private async onVoice(ctx: Context): Promise<void> {
    const voice = (ctx.message as { voice?: { file_id: string; mime_type?: string; duration?: number } } | undefined)?.voice;
    if (!voice) return;
    await this.handleAudioMessage(ctx, voice.file_id, voice.mime_type);
  }

  private async onAudio(ctx: Context): Promise<void> {
    const audio = (ctx.message as { audio?: { file_id: string; mime_type?: string } } | undefined)?.audio;
    if (!audio) return;
    await this.handleAudioMessage(ctx, audio.file_id, audio.mime_type);
  }

  private async handleAudioMessage(ctx: Context, fileId: string, mimeType?: string): Promise<void> {
    const sessions = this.handlers?.sessions;
    if (!sessions) {
      await ctx.reply("(session service unavailable)");
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = await sessions.getChatState("telegram", String(chatId));
    if (!state?.active_session_id) {
      await ctx.reply("no active session — /new claude (or /list then /resume) before sending voice.");
      return;
    }
    // Show a quick acknowledgement while we transcribe.
    void ctx.telegram.sendChatAction(chatId, "record_voice").catch(() => {});

    let buffer: Buffer;
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const res = await fetch(link.toString());
      if (!res.ok) throw new Error(`telegram file fetch returned ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      await ctx.reply(`could not download voice note: ${(err as Error).message}`);
      return;
    }

    let text: string;
    try {
      const opts: { mimeType?: string } = {};
      if (mimeType !== undefined) opts.mimeType = mimeType;
      text = await sessions.transcribeAudio(buffer, opts);
    } catch (err) {
      const msg = (err as Error).message;
      await ctx.reply(
        msg.includes("install-models") || msg.includes("whisper") || msg.includes("ffmpeg")
          ? `transcription unavailable: ${msg}\nRun: pnpm wazir:install-models`
          : `transcription failed: ${msg}`,
      );
      return;
    }
    if (!text.trim()) {
      await ctx.reply("(transcription returned empty — too short or silent?)");
      return;
    }
    // Transcript echo is always plain text, regardless of voice mode.
    await ctx.reply(`🎙 "${text.trim()}"`);
    // Claude's response is delivered separately and goes through the normal
    // voice mode check (text, voice note, or auto depending on /voice setting).
    await this.deliverPromptAndStream(ctx, sessions, state.active_session_id, text.trim());
  }

  /**
   * Wait for a new assistant turn to appear in the session's JSONL
   * transcript. This is the authoritative completion signal:
   *
   *   - Claude Code only appends JSONL lines when a turn is actually
   *     written (no half-written state).
   *   - The file's mtime updates on every line, so "mtime quiet for
   *     QUIET_MS" is a reliable "this turn is fully done" signal.
   *
   * Done = ALL of:
   *   - message_count strictly greater than before
   *   - last_assistant text differs from before (real text response,
   *     not a tool-only turn)
   *   - last_activity_at hasn't advanced for QUIET_MS (no more writes)
   *
   * Returns the new last_assistant text, or null on timeout.
   */
  private async waitForAssistantResponse(
    sessions: SessionService,
    sessionId: string,
    before: DiscoveredSession | null,
  ): Promise<string | null> {
    const start = Date.now();
    const QUIET_MS = 2000;
    const beforeCount = before?.message_count ?? 0;
    const beforeAssistant = before?.last_assistant ?? null;

    let lastSeenMtime = before?.last_activity_at ?? 0;
    let lastMtimeChangeAt = Date.now();

    while (Date.now() - start < this.maxWaitMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      let meta: DiscoveredSession | null;
      try {
        meta = await sessions.getDiscoveredSession(sessionId);
      } catch (err) {
        this.logger.warn({ err, sessionId }, "JSONL poll failed");
        continue;
      }
      if (!meta) continue;

      if (meta.last_activity_at !== lastSeenMtime) {
        lastSeenMtime = meta.last_activity_at;
        lastMtimeChangeAt = Date.now();
      }
      const hasNewTurn = meta.message_count > beforeCount;
      const hasNewAssistant =
        meta.last_assistant !== undefined &&
        meta.last_assistant.trim().length > 0 &&
        meta.last_assistant !== beforeAssistant;
      const isQuiet = Date.now() - lastMtimeChangeAt >= QUIET_MS;

      if (hasNewTurn && hasNewAssistant && isQuiet) {
        return meta.last_assistant ?? null;
      }
    }
    return null;
  }

  /**
   * Wait for the session's pane to indicate "Claude is done responding".
   *
   * The reliable signal is the Claude Code status bar — when Claude is
   * working, the visible pane contains a line like:
   *   `✳ Gusting… (1m 37s · ↓ 7.3k tokens)`
   * The `[↑↓] N tokens` pattern is unique to the working state.
   *
   * State machine:
   *   before  → status bar absent; haven't seen Claude start yet
   *   working → status bar present; Claude is actively responding
   *   settling → status bar just disappeared; verify with a stable tick
   *              (handles the brief render lag after the bar clears)
   *
   * This handles long responses correctly (mid-stream pauses no longer
   * look like "done") and fast responses too (if we miss the working
   * state, we fall back to "pane changed from baseline → settle").
   */
  private async waitForStablePane(
    sessions: SessionService,
    sessionId: string,
  ): Promise<string> {
    const start = Date.now();
    let lastRaw = "";
    let previousCleaned: string | null = null;
    let stableCount = 0;

    // Capture baseline.
    let baselineRaw: string | null = null;
    let baselineCleaned: string | null = null;
    try {
      const initial = await sessions.capturePane(sessionId, { visibleOnly: true });
      baselineRaw = initial.text;
      baselineCleaned = cleanPaneText(initial.text);
    } catch { /* baseline failed; we'll fall through with state=before */ }

    type State = "before" | "working" | "settling";
    let state: State = baselineRaw !== null && isClaudeWorking(baselineRaw) ? "working" : "before";

    while (Date.now() - start < this.maxWaitMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      let cap;
      try {
        cap = await sessions.capturePane(sessionId, { visibleOnly: true });
      } catch (err) {
        this.logger.warn({ err, sessionId }, "capture during poll failed");
        continue;
      }
      lastRaw = cap.text;
      const cleaned = cleanPaneText(cap.text);
      const working = isClaudeWorking(cap.text);

      if (state === "before") {
        if (working) {
          state = "working";
        } else if (baselineCleaned !== null && cleaned !== baselineCleaned) {
          // Claude finished before we caught the status bar — go straight to settle.
          state = "settling";
          previousCleaned = cleaned;
          stableCount = 0;
        }
        continue;
      }

      if (state === "working") {
        if (!working) {
          // Status bar just disappeared — start the settle phase.
          state = "settling";
          previousCleaned = cleaned;
          stableCount = 0;
        }
        // Otherwise still working — keep waiting, no timeout pressure.
        continue;
      }

      // settling
      if (working) {
        // Claude kicked off another turn (e.g., chained tool call) — back to working.
        state = "working";
        continue;
      }
      if (cleaned === previousCleaned) {
        stableCount += 1;
        if (stableCount >= this.stableTicks) return cap.text;
      } else {
        previousCleaned = cleaned;
        stableCount = 0;
      }
    }
    // Timed out — return whatever we last saw so the user gets something useful.
    return lastRaw;
  }

  private async onPhoto(ctx: Context): Promise<void> {
    const photos = (ctx.message as { photo?: Array<{ file_id: string; width: number; height: number }> } | undefined)?.photo;
    if (!photos || photos.length === 0) return;
    const largest = photos[photos.length - 1];
    if (!largest) return;
    const caption = (ctx.message as { caption?: string } | undefined)?.caption;
    await this.handleImageMessage(ctx, largest.file_id, ".jpg", caption);
  }

  private async onDocument(ctx: Context): Promise<void> {
    const doc = (ctx.message as { document?: { file_id: string; mime_type?: string; file_name?: string } } | undefined)?.document;
    if (!doc) return;
    const mime = doc.mime_type ?? "";
    if (!mime.startsWith("image/")) return;
    const ext = mimeToExt(mime);
    const caption = (ctx.message as { caption?: string } | undefined)?.caption;
    await this.handleImageMessage(ctx, doc.file_id, ext, caption);
  }

  private async handleImageMessage(
    ctx: Context,
    fileId: string,
    ext: string,
    caption: string | undefined,
  ): Promise<void> {
    const sessions = this.handlers?.sessions;
    if (!sessions) { await ctx.reply("(session service unavailable)"); return; }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = await sessions.getChatState("telegram", String(chatId));
    if (!state?.active_session_id) {
      await ctx.reply("no active session — /new claude (or /list then /resume) before sending images.");
      return;
    }

    let buffer: Buffer;
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const res = await fetch(link.toString());
      if (!res.ok) throw new Error(`telegram file fetch returned ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      await ctx.reply(`could not download image: ${(err as Error).message}`);
      return;
    }

    const tmpDir = resolve(homedir(), ".wazir", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, `wazir-${randomUUID()}${ext}`);
    writeFileSync(filePath, buffer);

    // Tell the user where it landed, then deliver to the session.
    await ctx.reply(`📎 ${filePath}`);
    const message = caption
      ? `[image: ${filePath}]\n${caption}`
      : `[image: ${filePath}]`;
    await this.deliverPromptAndStream(ctx, sessions, state.active_session_id, message);
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

/**
 * Score every session in `entries` against the user's free-text query
 * and return them ranked best-first.
 *
 * Scoring: tokenize the query into content words (drop stop words and
 * common navigation verbs like "switch"/"back"/"to"), then count how
 * many tokens appear in each session's searchable text. Title/label
 * matches count double — those are the user's deliberate names.
 */
function rankSessionsByQuery(
  query: string,
  entries: ListEntry[],
): Array<{ entry: ListEntry; score: number }> {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return entries.map((entry) => ({ entry, score: 0 }));

  const ranked = entries.map((entry) => {
    const titleBag = [entry.label, entry.agent_title, entry.ai_title]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    const bodyBag = [entry.first_message, entry.cwd]
      .filter((s): s is string => !!s)
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (titleBag.includes(tok)) score += 2;
      else if (bodyBag.includes(tok)) score += 1;
    }
    return { entry, score };
  });
  ranked.sort((a, b) => b.score - a.score || b.entry.last_activity_at - a.entry.last_activity_at);
  return ranked;
}

const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "for", "by", "with",
  "and", "or", "but", "if", "is", "are", "was", "were", "be", "been",
  "me", "my", "i", "you", "your", "we", "our", "it", "this", "that",
  "these", "those", "go", "back", "switch", "resume", "open", "show",
  "take", "into", "about", "convo", "conversation", "session", "session_id",
  "please", "pls",
]);

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t));
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return map[mime] ?? ".jpg";
}

/**
 * Detect whether the visible pane currently shows Claude's "working"
 * status line. The unique signature is the up/down arrow with token
 * counts, e.g. `↓ 7.3k tokens` or `↑ 240 tokens`. This appears in the
 * spinner line throughout the entire turn.
 */
function isClaudeWorking(raw: string): boolean {
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/\x1b\[[\d;]*[A-Za-z]/g, "");
  return /[↑↓]\s*[\d.]+k?\s*tokens?/i.test(t);
}

/**
 * Strip TUI chrome from a raw tmux pane capture so the output reads like
 * a normal conversation instead of a terminal screenshot.
 *
 * Removes: ANSI escape sequences, box-drawing border lines, the Claude
 * status bar (spinner + tokens), the keyboard hint line, the shell
 * prompt line, and collapses excessive blank lines.
 */
function cleanPaneText(raw: string): string {
  // Strip ANSI escape sequences (color, cursor movement, etc.)
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/\x1b\[[\d;]*[A-Za-z]/g, "").replace(/\x1b[()][AB012]/g, "");

  const lines = stripped.split("\n");
  const cleaned: string[] = [];
  for (const line of lines) {
    const t = line.trimEnd();
    // Skip lines that are purely box-drawing / border chrome
    if (!t || /^[\s╭╰╮╯│─┤├┼┘└┐┌]+$/.test(t)) continue;
    // Skip the Claude spinner/status line: "✳ Gusting… (1m 37s · ↓ 7.3k tokens)"
    if (/[↑↓]\s*[\d.]+k?\s*tokens?/i.test(t)) continue;
    // Legacy "Claude ●  42 tokens · esc to interrupt" + bare "esc to interrupt"
    if (/\d+\s*tokens?\b/i.test(t) && /esc\s+to\s+interrupt/i.test(t)) continue;
    if (/^\s*esc\s+to\s+interrupt\s*$/i.test(t)) continue;
    // Skip the keyboard-hint footer: "⏵⏵ accept edits on (shift+tab to cycle)"
    if (/^\s*⏵⏵\s+/.test(t)) continue;
    // Skip the user's shell prompt line (zsh/oh-my-zsh style)
    if (/^\s*➜\s+\S+\s+git:/.test(t)) continue;
    cleaned.push(t);
  }

  // Collapse runs of blank lines to a single blank
  const result: string[] = [];
  let prevBlank = false;
  for (const line of cleaned) {
    if (line === "") {
      if (!prevBlank) result.push("");
      prevBlank = true;
    } else {
      prevBlank = false;
      result.push(line);
    }
  }
  while (result.length > 0 && result[0] === "") result.shift();
  while (result.length > 0 && result[result.length - 1] === "") result.pop();

  return result.join("\n");
}
