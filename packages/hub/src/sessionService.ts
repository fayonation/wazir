import {
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  signPayload,
  SessionSchema,
  SessionCaptureSchema,
  DiscoveredSessionSchema,
  type ChatState,
  type DiscoveredSession,
  type Session,
  type SessionCapture,
  type SessionService,
} from "@wazir/protocol";
import { z } from "zod";
import type { SessionStore, WorkerStore, ChatStateStore, SessionLabelStore } from "./store.js";
import type { HubLogger } from "./logger.js";

export class HubSessionService implements SessionService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly workers: WorkerStore,
    private readonly chatState: ChatStateStore,
    private readonly labels: SessionLabelStore,
    private readonly hmacSecret: string,
    private readonly logger: HubLogger,
  ) {}

  async listSessions(opts: { workerId?: string; cwd?: string } = {}): Promise<Session[]> {
    const rows = this.sessions.list(opts);
    const ids = rows.map((r) => r.session_id);
    const labels = this.labels.getMany(ids);
    return rows.map((row) => {
      const session = rowToSession(row);
      const userLabel = labels.get(row.session_id);
      if (userLabel) session.label = userLabel;
      return session;
    });
  }

  async spawnSession(req: {
    agent: string;
    cwd: string;
    sessionId?: string;
    resume?: boolean;
    label?: string;
  }): Promise<Session> {
    const worker = this.workers.listWorkers()[0];
    if (!worker || !worker.worker_url) {
      throw new Error("no worker available");
    }
    const body: Record<string, unknown> = {
      agent: req.agent,
      cwd: req.cwd,
      resume: req.resume ?? false,
    };
    if (req.sessionId) body.session_id = req.sessionId;
    if (req.label) body.label = req.label;
    const res = await this.callWorker(worker.worker_url, "POST", "/v1/sessions/spawn", body);
    if (res.status !== 200) {
      throw new Error(`worker spawn failed: ${res.status} ${stringifyBody(res.body)}`);
    }
    const session = SessionSchema.parse(res.body);
    this.sessions.upsert(session);
    return session;
  }

  async killSession(sessionId: string): Promise<boolean> {
    const row = this.sessions.get(sessionId);
    if (!row) return false;
    const worker = this.workers.getWorker(row.worker_id);
    if (worker?.worker_url) {
      try {
        await this.callWorker(worker.worker_url, "DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
      } catch (err) {
        this.logger.warn({ err, session_id: sessionId }, "worker kill forwarding failed");
      }
    }
    this.sessions.delete(sessionId);
    return true;
  }

  async sendInput(sessionId: string, text: string, pressEnter = true): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const worker = this.workers.getWorker(row.worker_id);
    if (!worker?.worker_url) throw new Error(`worker unavailable for session ${sessionId}`);
    const res = await this.callWorker(
      worker.worker_url,
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/input`,
      { text, press_enter: pressEnter },
    );
    if (res.status >= 400) {
      throw new Error(`worker sendInput failed: ${res.status} ${stringifyBody(res.body)}`);
    }
  }

  async capturePane(
    sessionId: string,
    opts: { since?: number; visibleOnly?: boolean } = {},
  ): Promise<SessionCapture> {
    const row = this.sessions.get(sessionId);
    if (!row) throw new Error(`unknown session: ${sessionId}`);
    const worker = this.workers.getWorker(row.worker_id);
    if (!worker?.worker_url) throw new Error(`worker unavailable for session ${sessionId}`);
    const params = new URLSearchParams();
    if (opts.since !== undefined) params.set("since", String(opts.since));
    if (opts.visibleOnly) params.set("visible_only", "1");
    const qs = params.toString() ? `?${params}` : "";
    const res = await this.callWorker(
      worker.worker_url,
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/capture${qs}`,
    );
    if (res.status >= 400) {
      throw new Error(`worker capture failed: ${res.status} ${stringifyBody(res.body)}`);
    }
    return SessionCaptureSchema.parse(res.body);
  }

  async getChatState(adapter: string, chatKey: string): Promise<ChatState | null> {
    const row = this.chatState.get(adapter, chatKey);
    if (!row) return null;
    return {
      adapter: row.adapter,
      chat_key: row.chat_key,
      active_session_id: row.active_session_id,
      sticky_cwd: row.sticky_cwd,
      voice_mode: row.voice_mode,
    };
  }

  async setChatState(
    adapter: string,
    chatKey: string,
    patch: Partial<Pick<ChatState, "active_session_id" | "sticky_cwd" | "voice_mode">>,
  ): Promise<ChatState> {
    const row = this.chatState.upsert(adapter, chatKey, patch, Date.now());
    return {
      adapter: row.adapter,
      chat_key: row.chat_key,
      active_session_id: row.active_session_id,
      sticky_cwd: row.sticky_cwd,
      voice_mode: row.voice_mode,
    };
  }

  async listDiscoveredSessions(): Promise<DiscoveredSession[]> {
    const worker = this.workers.listWorkers()[0];
    if (!worker || !worker.worker_url) return [];
    try {
      const res = await this.callWorker(worker.worker_url, "GET", "/v1/sessions/discovered");
      if (res.status !== 200) {
        this.logger.warn({ status: res.status }, "discovered listing failed");
        return [];
      }
      const parsed = z.object({ sessions: z.array(DiscoveredSessionSchema) }).safeParse(res.body);
      if (!parsed.success) {
        this.logger.warn({ issues: parsed.error.issues }, "discovered listing returned invalid shape");
        return [];
      }
      const sessionsArr = parsed.data.sessions;
      // Layer in user-given labels.
      const ids = sessionsArr.map((s) => s.session_id);
      const labelMap = this.labels.getMany(ids);
      return sessionsArr.map((s) => {
        const userLabel = labelMap.get(s.session_id);
        return userLabel ? { ...s, label: userLabel } : s;
      });
    } catch (err) {
      this.logger.warn({ err }, "discovered listing fetch failed");
      return [];
    }
  }

  async getDiscoveredSession(sessionId: string): Promise<DiscoveredSession | null> {
    const worker = this.workers.listWorkers()[0];
    if (!worker || !worker.worker_url) return null;
    try {
      const res = await this.callWorker(
        worker.worker_url,
        "GET",
        `/v1/sessions/discovered/${encodeURIComponent(sessionId)}`,
      );
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      const parsed = DiscoveredSessionSchema.safeParse(res.body);
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.logger.warn({ err, session_id: sessionId }, "discovered lookup failed");
      return null;
    }
  }

  async resumeDiscoveredSession(sessionId: string): Promise<Session> {
    const meta = await this.getDiscoveredSession(sessionId);
    if (!meta) throw new Error(`no on-disk session for ${sessionId}`);
    return this.spawnSession({
      agent: meta.agent,
      cwd: meta.cwd,
      sessionId: meta.session_id,
      resume: true,
    });
  }

  async setSessionLabel(sessionId: string, label: string): Promise<void> {
    const trimmed = label.trim();
    if (trimmed === "") {
      this.labels.clear(sessionId);
    } else {
      this.labels.set(sessionId, trimmed, Date.now());
    }
  }

  private async callWorker(
    workerUrl: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(this.hmacSecret, raw, ts);
    const init: RequestInit = {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      ...(body !== undefined ? { body: raw } : {}),
    };
    const res = await fetch(`${workerUrl}${path}`, init);
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  }
}

function rowToSession(row: {
  session_id: string;
  worker_id: string;
  agent: string;
  cwd: string;
  tmux_name: string;
  status: "running" | "exited" | "unreachable";
  label: string | null;
  message_count: number | null;
  created_at: number;
  last_activity_at: number;
}): Session {
  const session: Session = {
    session_id: row.session_id,
    worker_id: row.worker_id,
    agent: row.agent,
    cwd: row.cwd,
    tmux_name: row.tmux_name,
    status: row.status,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
  };
  if (row.label !== null) session.label = row.label;
  if (row.message_count !== null) session.message_count = row.message_count;
  return session;
}

function stringifyBody(body: unknown): string {
  try { return JSON.stringify(body); } catch { return String(body); }
}
