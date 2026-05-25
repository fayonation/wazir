import Database, { type Database as DB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export interface ApprovalRow {
  approval_id: string;
  request_id: string;
  source: string;
  worker_id: string;
  session_id: string;
  command: string;
  context_json: string;
  callback_url: string;
  timeout_seconds: number;
  status: "pending" | "decided" | "timed_out" | "cancelled";
  decision: string | null;
  modified_command: string | null;
  actor: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface WorkerRow {
  worker_id: string;
  hostname: string;
  platform: string;
  version: string;
  capabilities_json: string;
  worker_url: string;
  registered_at: number;
  last_seen_at: number;
}

export interface SessionRow {
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
}

export interface ChatStateRow {
  adapter: string;
  chat_key: string;
  active_session_id: string | null;
  sticky_cwd: string | null;
  voice_mode: "auto" | "on" | "off";
  updated_at: number;
}

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

export function openDatabase(dbPath: string): DB {
  const abs = expandTilde(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      platform TEXT NOT NULL,
      version TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      worker_url TEXT NOT NULL DEFAULT '',
      registered_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      context_json TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','decided','timed_out','cancelled')),
      decision TEXT,
      modified_command TEXT,
      actor TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON approvals(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      cwd TEXT NOT NULL,
      tmux_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','exited','unreachable')),
      label TEXT,
      message_count INTEGER,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at DESC);

    CREATE TABLE IF NOT EXISTS chat_state (
      adapter TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      active_session_id TEXT,
      sticky_cwd TEXT,
      voice_mode TEXT NOT NULL DEFAULT 'auto' CHECK (voice_mode IN ('auto','on','off')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (adapter, chat_key)
    );
  `);

  // Best-effort additive migration for pre-existing 'workers' tables that
  // were created before worker_url was added. SQLite's ALTER TABLE ADD COLUMN
  // is safe and idempotent guarded by the introspection below.
  const cols = db.prepare(`PRAGMA table_info(workers)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "worker_url")) {
    db.exec(`ALTER TABLE workers ADD COLUMN worker_url TEXT NOT NULL DEFAULT ''`);
  }
}
