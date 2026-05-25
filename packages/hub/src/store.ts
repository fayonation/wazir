import type { Database as DB } from "better-sqlite3";
import type {
  ApprovalRequest,
  ApprovalAction,
  WorkerRegistration,
} from "@wazir/protocol";
import type { ApprovalRow, WorkerRow } from "./db.js";

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
        `INSERT INTO workers (worker_id, hostname, platform, version, capabilities_json, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           hostname = excluded.hostname,
           platform = excluded.platform,
           version = excluded.version,
           capabilities_json = excluded.capabilities_json,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        reg.worker_id,
        reg.hostname,
        reg.platform,
        reg.version,
        JSON.stringify(reg.capabilities),
        now,
        now,
      );
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
