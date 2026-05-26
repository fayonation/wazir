import type { HubNotification } from "./notification.js";
import type { UserDecision } from "./approval.js";
import type { Session, SessionCapture } from "./session.js";

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
  }): Promise<Session>;

  killSession(sessionId: string): Promise<boolean>;

  sendInput(sessionId: string, text: string, pressEnter?: boolean): Promise<void>;

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
}
