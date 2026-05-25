import type { Database as DB } from "better-sqlite3";
import type {
  ApprovalRequest,
  ApprovalAction,
  WorkerRegistration,
  Session,
} from "@wazir/protocol";
import type { ApprovalRow, WorkerRow, SessionRow, ChatStateRow } from "./db.js";

export class ApprovalStore {
  constructor(private readonly db: DB) {}

  insertApproval(approvalId: string, req: ApprovalRequest, now: number): void {
    this.db
      .prepare(
        `INSERT INTO approvals (
          approval_id, request_id, source, worker_id, session_id,
          command, context_json, callback_url, timeout_seconds,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        approvalId,
        req.request_id,
        req.source,
        req.worker_id,
        req.session_id,
        req.command,
        JSON.stringify(req.context),
        req.callback_url,
        req.timeout_seconds,
        now,
      );
  }

  getApproval(approvalId: string): ApprovalRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE approval_id = ?`)
      .get(approvalId) as ApprovalRow | undefined;
    return row;
  }

  decideApproval(
    approvalId: string,
    decision: ApprovalAction,
    finalCommand: string,
    actor: string,
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = 'decided', decision = ?, modified_command = ?, actor = ?, decided_at = ?
         WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(decision, finalCommand, actor, now, approvalId);
    return result.changes > 0;
  }

  markTimedOut(approvalId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE approvals SET status = 'timed_out', decided_at = ?
         WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(now, approvalId);
  }

  recentApprovals(limit = 50): ApprovalRow[] {
    return this.db
      .prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ApprovalRow[];
  }
}

export class WorkerStore {
  constructor(private readonly db: DB) {}

  upsertWorker(reg: WorkerRegistration, now: number): void {
    this.db
      .prepare(
        `INSERT INTO workers (worker_id, hostname, platform, version, capabilities_json, worker_url, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           hostname = excluded.hostname,
           platform = excluded.platform,
           version = excluded.version,
           capabilities_json = excluded.capabilities_json,
           worker_url = excluded.worker_url,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        reg.worker_id,
        reg.hostname,
        reg.platform,
        reg.version,
        JSON.stringify(reg.capabilities),
        reg.worker_url,
        now,
        now,
      );
  }

  getWorker(workerId: string): WorkerRow | undefined {
    return this.db
      .prepare(`SELECT * FROM workers WHERE worker_id = ?`)
      .get(workerId) as WorkerRow | undefined;
  }

  heartbeat(workerId: string, now: number): boolean {
    const result = this.db
      .prepare(`UPDATE workers SET last_seen_at = ? WHERE worker_id = ?`)
      .run(now, workerId);
    return result.changes > 0;
  }

  listWorkers(): WorkerRow[] {
    return this.db.prepare(`SELECT * FROM workers ORDER BY worker_id`).all() as WorkerRow[];
  }
}

export class SessionStore {
  constructor(private readonly db: DB) {}

  upsert(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, worker_id, agent, cwd, tmux_name, status, label, message_count, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           worker_id = excluded.worker_id,
           agent = excluded.agent,
           cwd = excluded.cwd,
           tmux_name = excluded.tmux_name,
           status = excluded.status,
           label = excluded.label,
           message_count = excluded.message_count,
           last_activity_at = excluded.last_activity_at`,
      )
      .run(
        session.session_id,
        session.worker_id,
        session.agent,
        session.cwd,
        session.tmux_name,
        session.status,
        session.label ?? null,
        session.message_count ?? null,
        session.created_at,
        session.last_activity_at,
      );
  }

  get(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
  }

  list(opts: { workerId?: string; cwd?: string; limit?: number } = {}): SessionRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.workerId) {
      clauses.push("worker_id = ?");
      params.push(opts.workerId);
    }
    if (opts.cwd) {
      clauses.push("cwd = ?");
      params.push(opts.cwd);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    return this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity_at DESC LIMIT ?`)
      .all(...params, limit) as SessionRow[];
  }

  delete(sessionId: string): boolean {
    const res = this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
    return res.changes > 0;
  }

  /** Replace the live-session set for a worker with the report from its heartbeat. */
  reconcile(workerId: string, sessions: Session[], now: number): void {
    const existing = this.list({ workerId });
    const incomingIds = new Set(sessions.map((s) => s.session_id));
    const txn = this.db.transaction(() => {
      for (const s of sessions) {
        this.upsert(s);
      }
      for (const row of existing) {
        if (!incomingIds.has(row.session_id) && row.status === "running") {
          // Worker no longer reports this session; mark exited.
          this.db
            .prepare(`UPDATE sessions SET status = 'exited', last_activity_at = ? WHERE session_id = ?`)
            .run(now, row.session_id);
        }
      }
    });
    txn();
  }
}

export class ChatStateStore {
  constructor(private readonly db: DB) {}

  get(adapter: string, chatKey: string): ChatStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM chat_state WHERE adapter = ? AND chat_key = ?`)
      .get(adapter, chatKey) as ChatStateRow | undefined;
  }

  upsert(
    adapter: string,
    chatKey: string,
    patch: Partial<Pick<ChatStateRow, "active_session_id" | "sticky_cwd" | "voice_mode">>,
    now: number,
  ): ChatStateRow {
    const current = this.get(adapter, chatKey);
    const next: ChatStateRow = {
      adapter,
      chat_key: chatKey,
      active_session_id: patch.active_session_id ?? current?.active_session_id ?? null,
      sticky_cwd: patch.sticky_cwd ?? current?.sticky_cwd ?? null,
      voice_mode: patch.voice_mode ?? current?.voice_mode ?? "auto",
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO chat_state (adapter, chat_key, active_session_id, sticky_cwd, voice_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(adapter, chat_key) DO UPDATE SET
           active_session_id = excluded.active_session_id,
           sticky_cwd = excluded.sticky_cwd,
           voice_mode = excluded.voice_mode,
           updated_at = excluded.updated_at`,
      )
      .run(
        next.adapter,
        next.chat_key,
        next.active_session_id,
        next.sticky_cwd,
        next.voice_mode,
        next.updated_at,
      );
    return next;
  }
}
