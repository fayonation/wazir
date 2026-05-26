import { hostname, userInfo } from "node:os";
import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";
import { signPayload, HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP } from "@wazir/protocol";

interface ApprovalRow {
  approval_id: string;
  command: string;
  status: string;
  decision: string | null;
  actor: string | null;
  created_at: number;
  decided_at: number | null;
  source?: string;
  worker_id?: string;
  cwd?: string;
}

async function fetchApprovals(limit = 50): Promise<{ hubUrl: string; rows: ApprovalRow[] } | null> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const hmacSecret = await resolveHmacSecret();
  if (!hmacSecret) {
    console.error("error: HMAC secret missing. Cannot query hub.");
    process.exitCode = 1;
    return null;
  }
  const hubUrl = config.hub.url ?? `http://${config.hub.bind_host}:${config.hub.bind_port}`;
  const ts = Math.floor(Date.now() / 1000);
  const sig = signPayload(hmacSecret, "", ts);
  try {
    const res = await fetch(`${hubUrl}/v1/approvals?limit=${limit}`, {
      headers: {
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`hub returned ${res.status}`);
      process.exitCode = 1;
      return null;
    }
    const body = (await res.json()) as { approvals: ApprovalRow[] };
    return { hubUrl, rows: body.approvals };
  } catch (err) {
    console.error(`hub unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

function pendingOnly(rows: ApprovalRow[]): ApprovalRow[] {
  return rows.filter((r) => r.status === "pending");
}

function actorTag(): string {
  return `cli:${userInfo().username}@${hostname()}`;
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export async function runApprovalPending(): Promise<void> {
  const result = await fetchApprovals(50);
  if (!result) return;
  const pending = pendingOnly(result.rows);
  if (pending.length === 0) {
    console.log("(no pending approvals)");
    return;
  }
  for (const a of pending) {
    const id = a.approval_id.slice(0, 8);
    const where = a.worker_id ? ` @ ${a.worker_id}` : "";
    const cwd = a.cwd ? ` : ${a.cwd}` : "";
    console.log(`${id}  ${relative(a.created_at).padStart(8)}${where}${cwd}`);
    console.log(`         ${a.command}`);
  }
}

async function resolveApproval(idPrefix: string | undefined): Promise<{ hubUrl: string; row: ApprovalRow } | null> {
  const result = await fetchApprovals(50);
  if (!result) return null;
  const pending = pendingOnly(result.rows);
  if (idPrefix === undefined) {
    if (pending.length === 0) {
      console.error("(no pending approvals)");
      process.exitCode = 1;
      return null;
    }
    if (pending.length === 1) {
      const row = pending[0];
      if (!row) {
        console.error("(internal: pending list inconsistent)");
        process.exitCode = 1;
        return null;
      }
      return { hubUrl: result.hubUrl, row };
    }
    console.error(`multiple pending approvals (${pending.length}). pass an id prefix:`);
    for (const a of pending) {
      console.error(`  ${a.approval_id.slice(0, 8)}  ${a.command}`);
    }
    process.exitCode = 1;
    return null;
  }
  const matches = pending.filter((r) => r.approval_id.startsWith(idPrefix));
  if (matches.length === 0) {
    console.error(`no pending approval matches ${idPrefix}`);
    process.exitCode = 1;
    return null;
  }
  if (matches.length > 1) {
    console.error(`ambiguous: ${matches.length} pending approvals start with ${idPrefix}`);
    process.exitCode = 1;
    return null;
  }
  const row = matches[0];
  if (!row) {
    console.error("(internal: empty match after filter)");
    process.exitCode = 1;
    return null;
  }
  return { hubUrl: result.hubUrl, row };
}

async function postDecision(
  hubUrl: string,
  approvalId: string,
  body: { action: "approve" | "reject" | "modify"; actor: string; modified_command?: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${hubUrl}/v1/approvals/${encodeURIComponent(approvalId)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      console.error(`hub returned ${res.status} ${detail}`);
      process.exitCode = 1;
      return false;
    }
    return true;
  } catch (err) {
    console.error(`hub unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
    return false;
  }
}

export async function runApprovalApprove(idPrefix?: string): Promise<void> {
  const resolved = await resolveApproval(idPrefix);
  if (!resolved) return;
  const ok = await postDecision(resolved.hubUrl, resolved.row.approval_id, {
    action: "approve",
    actor: actorTag(),
  });
  if (ok) console.log(`✓ approved ${resolved.row.approval_id.slice(0, 8)}: ${resolved.row.command}`);
}

export async function runApprovalReject(idPrefix?: string): Promise<void> {
  const resolved = await resolveApproval(idPrefix);
  if (!resolved) return;
  const ok = await postDecision(resolved.hubUrl, resolved.row.approval_id, {
    action: "reject",
    actor: actorTag(),
  });
  if (ok) console.log(`✗ rejected ${resolved.row.approval_id.slice(0, 8)}: ${resolved.row.command}`);
}

export async function runApprovalModify(idPrefix: string, newCommand: string): Promise<void> {
  const resolved = await resolveApproval(idPrefix);
  if (!resolved) return;
  const ok = await postDecision(resolved.hubUrl, resolved.row.approval_id, {
    action: "modify",
    actor: actorTag(),
    modified_command: newCommand,
  });
  if (ok) console.log(`✎ modified ${resolved.row.approval_id.slice(0, 8)}: ${newCommand}`);
}
