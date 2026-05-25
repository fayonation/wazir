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
}

export interface CaptureOptions {
  since?: number;
  /** Maximum bytes to return. Tail is preferred if exceeded. Default 64 KiB. */
  maxBytes?: number;
}

export interface CaptureResult {
  text: string;
  cursor: number;
  full: boolean;
}

interface TrackedSession {
  session: Session;
  paneCursor: number;
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
    const tmuxName = `${TMUX_NAME_PREFIX}${opts.agent}-${sessionId}`;

    if (await hasSession(tmuxName)) {
      throw new TmuxError(`tmux session already exists: ${tmuxName}`, "", null);
    }
    if (!existsSync(opts.cwd)) {
      throw new Error(`cwd does not exist: ${opts.cwd}`);
    }

    const paneShell = process.env.SHELL ?? "/bin/bash";
    // tmux new-session -d -s <name> -c <cwd> <shell>
    // (omit `--` so tmux gets a single shell-command string; this avoids
    // argv-joining surprises across tmux versions.)
    await tmux(["new-session", "-d", "-s", tmuxName, "-c", opts.cwd, paneShell]);

    // Type the agent invocation into the freshly-opened shell. If the agent
    // exits later, the user is left in an interactive shell instead of a
    // dead pane.
    const agentInvocation = (opts.command ?? defaultCommandFor(opts.agent, sessionId, Boolean(opts.resume)))
      .map(quoteForShell)
      .join(" ");
    // Use -l (literal) so quoting in the command string isn't re-interpreted.
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
    this.tracked.set(sessionId, { session, paneCursor: 0 });
    this.logger.info({ session_id: sessionId, tmux_name: tmuxName, agent: opts.agent, cwd: opts.cwd }, "tmux session spawned");
    return session;
  }

  /** Return all tracked sessions, refreshing their status from tmux. */
  async listSessions(): Promise<Session[]> {
    const live = await listLiveTmuxSessions();
    const liveByName = new Map(live.map((s) => [s.name, s.createdAt] as const));

    for (const tracked of this.tracked.values()) {
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

  /** Read the pane buffer. Uses a per-session byte cursor for delta reads. */
  async capturePane(sessionId: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) throw new Error(`unknown session: ${sessionId}`);
    // capture-pane -t <name> -p -S -                 (whole scrollback as text)
    // capture-pane -t <name> -p -S <line> -E <line>  (range — but we work by bytes)
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
    const maxBytes = opts.maxBytes ?? 64 * 1024;
    const tooLong = delta.length > maxBytes;
    const text = tooLong ? delta.slice(delta.length - maxBytes) : delta;
    tracked.paneCursor = fullText.length;
    return { text, cursor: fullText.length, full: tooLong };
  }

  /** Forget all tracked sessions without killing them. Used on graceful shutdown. */
  forgetAll(): void {
    this.tracked.clear();
  }

  /** Forget a single session without killing tmux. Used when reconciliation finds it gone. */
  forget(sessionId: string): void {
    this.tracked.delete(sessionId);
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
}

async function listLiveTmuxSessions(): Promise<LiveTmuxSession[]> {
  try {
    const { stdout } = await tmux(["list-sessions", "-F", "#{session_name}|#{session_created}"]);
    const out: LiveTmuxSession[] = [];
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const [name, createdStr] = line.split("|");
      if (!name || !name.startsWith(TMUX_NAME_PREFIX)) continue;
      const createdAt = createdStr ? Number.parseInt(createdStr, 10) * 1000 : Date.now();
      out.push({ name, createdAt });
    }
    return out;
  } catch {
    // no sessions
    return [];
  }
}
