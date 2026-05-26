import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Session } from "@wazir/protocol";
import { tmux, hasSession, TmuxError } from "./exec.js";
import { SessionLockMap } from "./lock.js";
import type { WorkerLogger } from "../logger.js";

const TMUX_NAME_PREFIX = "wazir-";

export interface SpawnOptions {
  agent: string;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  label?: string;
  /**
   * Override the command Wazir runs in the pane. Defaults to a sane
   * invocation for the named agent (`claude --session-id <id>` for claude).
   * Passed as discrete argv entries — no shell.
   */
  command?: string[];
  /**
   * "print" (default) — the session is driven via `claude --print --resume`
   *   from outside; no tmux pane is created. We just track the session id
   *   plus its cwd in memory so /list/kill/etc. still work. The JSONL is
   *   created on the first message by `claude --print --session-id`.
   *
   * "tmux" — the legacy interactive flow: spawn a tmux pane with `claude`
   *   running inside, and use `tmux send-keys` for input. Required if you
   *   want `/screen` / `/capture` to reflect a live TUI for this session.
   *
   * Print mode and tmux mode CANNOT coexist on the same session_id — two
   * Claude processes appending to the same JSONL would corrupt it.
   */
  mode?: "print" | "tmux";
}

export interface CaptureOptions {
  since?: number;
  /** Maximum bytes to return. Tail is preferred if exceeded. Default 64 KiB. */
  maxBytes?: number;
  /**
   * When true, capture only what's currently visible on the pane (no
   * scrollback). Best for polling TUIs like Claude Code that repaint
   * in place and where "the answer" is whatever's on the screen now.
   */
  visibleOnly?: boolean;
}

export interface CaptureResult {
  text: string;
  cursor: number;
  full: boolean;
}

interface TrackedSession {
  session: Session;
  paneCursor: number;
  /**
   * Whether this session is backed by a tmux pane ("tmux") or driven
   * externally via `claude --print --resume` ("print"). Print-mode
   * sessions don't have a live process to check, so listSessions
   * reports them as running until they're killed.
   */
  mode: "print" | "tmux";
}

export class TmuxManager {
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly locks = new SessionLockMap();

  constructor(
    private readonly logger: WorkerLogger,
    private readonly workerId: string,
  ) {}

  /**
   * Spawn a new tmux session running the requested agent.
   *
   * The pane shell is always `bash` (or a configured shell). The agent is
   * launched as the first command typed into that shell. This keeps the
   * pane alive across agent restarts/crashes, gives the user a usable
   * shell to fall back to, and avoids tmux's "pane dies when its command
   * exits" behaviour killing our session entirely.
   */
  async spawnSession(opts: SpawnOptions): Promise<Session> {
    const sessionId = opts.sessionId ?? randomUUID();
    const mode = opts.mode ?? "print";
    if (!existsSync(opts.cwd)) {
      throw new Error(`cwd does not exist: ${opts.cwd}`);
    }
    if (mode === "print") {
      // Print mode: no tmux pane. The session is just a tracked record. The
      // first `claude --print --session-id <id>` invocation will create the
      // JSONL on disk; subsequent invocations use `--resume`.
      const now = Date.now();
      const session: Session = {
        session_id: sessionId,
        worker_id: this.workerId,
        agent: opts.agent,
        cwd: opts.cwd,
        // The Session schema requires tmux_name; use the same name we'd
        // pick for a real tmux pane so /screen etc. can flip to tmux mode
        // later if we want, but never actually spawn it.
        tmux_name: `${TMUX_NAME_PREFIX}${opts.agent}-${sessionId}`,
        status: "running",
        created_at: now,
        last_activity_at: now,
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      };
      this.tracked.set(sessionId, { session, paneCursor: 0, mode });
      this.logger.info({ session_id: sessionId, agent: opts.agent, cwd: opts.cwd }, "session registered (print mode)");
      return session;
    }
    // mode === "tmux" — legacy interactive flow.
    const tmuxName = `${TMUX_NAME_PREFIX}${opts.agent}-${sessionId}`;
    if (await hasSession(tmuxName)) {
      throw new TmuxError(`tmux session already exists: ${tmuxName}`, "", null);
    }
    const paneShell = process.env.SHELL ?? "/bin/bash";
    await tmux(["new-session", "-d", "-s", tmuxName, "-c", opts.cwd, paneShell]);
    const agentInvocation = (opts.command ?? defaultCommandFor(opts.agent, sessionId, Boolean(opts.resume)))
      .map(quoteForShell)
      .join(" ");
    await tmux(["send-keys", "-t", tmuxName, "-l", "--", agentInvocation]);
    await tmux(["send-keys", "-t", tmuxName, "Enter"]);
    const now = Date.now();
    const session: Session = {
      session_id: sessionId,
      worker_id: this.workerId,
      agent: opts.agent,
      cwd: opts.cwd,
      tmux_name: tmuxName,
      status: "running",
      created_at: now,
      last_activity_at: now,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
    };
    this.tracked.set(sessionId, { session, paneCursor: 0, mode });
    this.logger.info({ session_id: sessionId, tmux_name: tmuxName, agent: opts.agent, cwd: opts.cwd }, "tmux session spawned");
    return session;
  }

  /** Return all tracked sessions, refreshing their status from tmux. */
  async listSessions(): Promise<Session[]> {
    const live = await listLiveTmuxSessions();
    const liveByName = new Map(live.map((s) => [s.name, s.createdAt] as const));

    for (const tracked of this.tracked.values()) {
      if (tracked.mode === "print") {
        // No tmux pane to check; print sessions live as long as we track them.
        tracked.session.status = "running";
        continue;
      }
      const isAlive = liveByName.has(tracked.session.tmux_name);
      tracked.session.status = isAlive ? "running" : "exited";
    }
    return [...this.tracked.values()].map((t) => t.session);
  }

  /** Kill the underlying tmux session and forget it. */
  async killSession(sessionId: string): Promise<boolean> {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return false;
    try {
      await tmux(["kill-session", "-t", tracked.session.tmux_name]);
    } catch (err) {
      this.logger.warn({ err, session_id: sessionId }, "tmux kill-session failed (already gone?)");
    }
    this.tracked.delete(sessionId);
    return true;
  }

  /** Type text into the session's pane. Press Enter unless disabled. */
  async sendInput(sessionId: string, text: string, pressEnter = true): Promise<void> {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) throw new Error(`unknown session: ${sessionId}`);
    await this.locks.run(sessionId, async () => {
      await tmux(["send-keys", "-t", tracked.session.tmux_name, "-l", "--", text]);
      if (pressEnter) {
        await tmux(["send-keys", "-t", tracked.session.tmux_name, "Enter"]);
      }
      tracked.session.last_activity_at = Date.now();
    });
  }

  /**
   * Read the pane buffer.
   *
   * Default mode: full scrollback + visible, sliced from a per-session
   * byte cursor for delta reads. Best for shells that append to history.
   *
   * `visibleOnly` mode: only the currently visible pane (no scrollback),
   * returned as-is with no delta tracking. Best for polling TUIs like
   * Claude Code that repaint in place.
   */
  async capturePane(sessionId: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) throw new Error(`unknown session: ${sessionId}`);
    const maxBytes = opts.maxBytes ?? 64 * 1024;
    if (opts.visibleOnly) {
      // capture-pane -t <name> -p -J  (visible pane only, joined wrapped lines)
      const result = await tmux([
        "capture-pane",
        "-t",
        tracked.session.tmux_name,
        "-p",
        "-J",
      ]);
      const visible = result.stdout;
      const tooLong = visible.length > maxBytes;
      const text = tooLong ? visible.slice(visible.length - maxBytes) : visible;
      return { text, cursor: visible.length, full: tooLong };
    }
    const result = await tmux([
      "capture-pane",
      "-t",
      tracked.session.tmux_name,
      "-p",
      "-S",
      "-",
      "-J",
    ]);
    const fullText = result.stdout;
    const cursorBefore = opts.since ?? tracked.paneCursor;
    const delta = cursorBefore <= fullText.length ? fullText.slice(cursorBefore) : fullText;
    const tooLong = delta.length > maxBytes;
    const text = tooLong ? delta.slice(delta.length - maxBytes) : delta;
    tracked.paneCursor = fullText.length;
    return { text, cursor: fullText.length, full: tooLong };
  }

  /** Forget all tracked sessions without killing them. Used on graceful shutdown. */
  forgetAll(): void {
    this.tracked.clear();
  }

  /**
   * Re-register any live wazir-* tmux sessions that aren't already tracked.
   * Called on startup so a worker restart doesn't orphan sessions that tmux
   * is still running. Returns the count of newly registered sessions.
   */
  async rehydrate(): Promise<number> {
    const live = await listLiveTmuxSessions();
    let count = 0;
    for (const s of live) {
      // Name format: wazir-{agent}-{uuid}  (uuid is always 36 chars: 8-4-4-4-12)
      const withoutPrefix = s.name.slice(TMUX_NAME_PREFIX.length);
      if (withoutPrefix.length < 37) continue;
      const uuidStart = withoutPrefix.length - 36;
      if (withoutPrefix[uuidStart - 1] !== "-") continue;
      const sessionId = withoutPrefix.slice(uuidStart);
      const agent = withoutPrefix.slice(0, uuidStart - 1);
      if (!sessionId || !agent) continue;
      if (this.tracked.has(sessionId)) continue;
      const session: Session = {
        session_id: sessionId,
        worker_id: this.workerId,
        agent,
        cwd: s.cwd || (process.env.HOME ?? "/"),
        tmux_name: s.name,
        status: "running",
        created_at: s.createdAt,
        last_activity_at: s.createdAt,
      };
      this.tracked.set(sessionId, { session, paneCursor: 0, mode: "tmux" });
      count++;
      this.logger.info({ session_id: sessionId, tmux_name: s.name, agent }, "rehydrated session from live tmux");
    }
    return count;
  }

  /** Forget a single session without killing tmux. Used when reconciliation finds it gone. */
  forget(sessionId: string): void {
    this.tracked.delete(sessionId);
  }

  /**
   * If `sessionId` currently has a live tmux pane, kill the pane but keep
   * the tracked record alive in print mode. Used when we're about to run
   * `claude --print --resume <id>` against this session: two `claude`
   * processes appending to the same JSONL would corrupt it, so we hand
   * ownership of the session over to the print runner.
   *
   * No-op if the session is already in print mode or not tracked.
   */
  async releaseTmuxPane(sessionId: string): Promise<void> {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    if (tracked.mode !== "tmux") return;
    try {
      await tmux(["kill-session", "-t", tracked.session.tmux_name]);
    } catch (err) {
      this.logger.warn({ err, session_id: sessionId }, "tmux kill on release failed (pane already gone?)");
    }
    tracked.mode = "print";
    this.logger.info({ session_id: sessionId, tmux_name: tracked.session.tmux_name }, "tmux pane released; session now in print mode");
  }
}

function defaultCommandFor(agent: string, sessionId: string, resume: boolean): string[] {
  if (agent === "claude") {
    const idArg = resume ? "--resume" : "--session-id";
    return ["claude", idArg, sessionId];
  }
  if (agent === "bash" || agent === "shell") {
    // Pane already runs a shell; sending another `bash` would just nest one.
    // Send `true` so the pane prompt is ready immediately with no side effect.
    return ["true"];
  }
  // Fallback: just launch the named binary.
  return [agent];
}

/**
 * POSIX shell single-quote escape. Keeps user-provided cwd / command tokens
 * safe when re-assembling into a string we type into the pane shell.
 */
function quoteForShell(s: string): string {
  if (s === "") return "''";
  if (/^[a-zA-Z0-9_\-./:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface LiveTmuxSession {
  name: string;
  createdAt: number;
  cwd: string;
}

async function listLiveTmuxSessions(): Promise<LiveTmuxSession[]> {
  try {
    // list-panes -a gives one row per pane; use the first pane per session for the cwd.
    const { stdout } = await tmux(["list-panes", "-a", "-F", "#{session_name}|#{session_created}|#{pane_current_path}"]);
    const seen = new Set<string>();
    const out: LiveTmuxSession[] = [];
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split("|");
      const name = parts[0] ?? "";
      const createdStr = parts[1] ?? "";
      const cwd = parts[2] ?? "";
      if (!name || !name.startsWith(TMUX_NAME_PREFIX)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const createdAt = createdStr ? Number.parseInt(createdStr, 10) * 1000 : Date.now();
      out.push({ name, createdAt, cwd });
    }
    return out;
  } catch {
    return [];
  }
}
