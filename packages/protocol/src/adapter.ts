import type { HubNotification } from "./notification.js";
import type { UserDecision } from "./approval.js";
import type { Session, SessionCapture, DiscoveredSession, SessionPromptResponse } from "./session.js";

export type DecisionHandler = (approvalId: string, decision: UserDecision) => Promise<void>;

export interface InterfaceAdapter {
  readonly name: string;

  start(handlers: AdapterHandlers): Promise<void>;

  sendNotification(n: HubNotification): Promise<void>;

  cancelNotification?(approvalId: string, reason: string): Promise<void>;

  stop(): Promise<void>;
}

export interface AdapterHandlers {
  onDecision: DecisionHandler;
  sessions?: SessionService;
}

/** Per-chat state remembered by the hub across messages. */
export interface ChatState {
  adapter: string;
  chat_key: string;
  active_session_id: string | null;
  sticky_cwd: string | null;
  voice_mode: "auto" | "on" | "off";
}

/**
 * In-process facade an adapter uses to do session work. The hub provides
 * this when it `start()`s each adapter; the adapter never makes HTTP
 * calls back to the hub for these operations.
 */
export interface SessionService {
  listSessions(opts?: { workerId?: string; cwd?: string }): Promise<Session[]>;

  spawnSession(req: {
    agent: string;
    cwd: string;
    sessionId?: string;
    resume?: boolean;
    label?: string;
    /**
     * "print" (default) — register the session without spawning a tmux
     * pane; turns will be driven by `claude --print --resume` from the
     * worker.
     * "tmux" — legacy interactive tmux session.
     */
    mode?: "print" | "tmux";
  }): Promise<Session>;

  killSession(sessionId: string): Promise<boolean>;

  sendInput(sessionId: string, text: string, pressEnter?: boolean): Promise<void>;

  /**
   * Run one non-interactive Claude Code turn against the session via
   * `claude --print --resume`. Returns the final assistant text plus
   * metadata about tools used. This is the preferred path for
   * adapter→agent communication — the alternative (`sendInput` +
   * pane/JSONL polling) is the legacy tmux flow.
   */
  runPrompt(sessionId: string, text: string, opts?: { cwd?: string }): Promise<SessionPromptResponse>;

  capturePane(
    sessionId: string,
    opts?: { since?: number; visibleOnly?: boolean },
  ): Promise<SessionCapture>;

  getChatState(adapter: string, chatKey: string): Promise<ChatState | null>;

  setChatState(
    adapter: string,
    chatKey: string,
    patch: Partial<Pick<ChatState, "active_session_id" | "sticky_cwd" | "voice_mode">>,
  ): Promise<ChatState>;

  /**
   * Enumerate persisted agent sessions on disk that aren't currently in a
   * tmux pane. These can be resumed via `resumeDiscoveredSession`.
   * Phase 2 only supports Claude Code discovery (~/.claude/projects).
   */
  listDiscoveredSessions(): Promise<DiscoveredSession[]>;

  /** Look up the metadata for one discovered session by id. */
  getDiscoveredSession(sessionId: string): Promise<DiscoveredSession | null>;

  /**
   * Spawn a tmux pane that resumes the given on-disk session (runs
   * `claude --resume <session_id>` in its original cwd). Returns the
   * new tracked Session.
   */
  resumeDiscoveredSession(sessionId: string): Promise<Session>;

  /**
   * Set or clear the user-given name for a session. Works for both
   * tracked and discovered sessions; the label persists across kill/respawn.
   * Pass an empty/whitespace string to clear.
   */
  setSessionLabel(sessionId: string, label: string): Promise<void>;

  /**
   * Transcribe an audio buffer to text via the worker's local whisper.cpp.
   * Throws if dependencies (whisper binary or model file) are missing.
   */
  transcribeAudio(audio: Buffer, opts?: { mimeType?: string; language?: string }): Promise<string>;

  /**
   * Synthesize text to speech via the worker's local piper TTS.
   * Returns an OGG/Opus audio buffer ready to send as a Telegram voice note.
   * Throws if piper binary or voice model are missing.
   */
  synthesizeText(text: string): Promise<Buffer>;

  /**
   * Render the active session's visible pane as a PNG screenshot.
   * Returns a raw PNG buffer ready to send as a Telegram photo.
   */
  screenshotPane(sessionId: string, opts?: { label?: string }): Promise<Buffer>;
}
