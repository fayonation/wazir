import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";
import {
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  signPayload,
  SessionSchema,
  type Session,
} from "@wazir/protocol";

interface HttpResult {
  status: number;
  body: unknown;
}

async function hubRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const secret = await resolveHmacSecret();
  if (!secret) throw new Error("HMAC secret unavailable. Run 'pnpm wazir:init' or set WAZIR_HMAC_SECRET.");
  const hubUrl = config.hub.url ?? `http://${config.hub.bind_host}:${config.hub.bind_port}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signPayload(secret, raw, ts);
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      [HMAC_HEADER_SIGNATURE]: sig,
      [HMAC_HEADER_TIMESTAMP]: String(ts),
    },
    ...(body !== undefined ? { body: raw } : {}),
    signal: AbortSignal.timeout(8000),
  };
  const res = await fetch(`${hubUrl}${path}`, init);
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

export async function runSessionNew(agent: string, opts: { cwd?: string; label?: string }): Promise<void> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const body: Record<string, unknown> = { agent, cwd };
  if (opts.label) body.label = opts.label;
  const result = await hubRequest("POST", "/v1/sessions", body);
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const session = SessionSchema.parse(result.body);
  console.log(`spawned ${session.tmux_name}`);
  console.log(`  session_id: ${session.session_id}`);
  console.log(`  agent:      ${session.agent}`);
  console.log(`  cwd:        ${session.cwd}`);
  console.log(`\nattach with: tmux attach -t ${session.tmux_name}`);
  console.log(`  (or:        pnpm wazir session attach ${session.session_id})`);
}

export async function runSessionList(opts: { workerId?: string; cwd?: string } = {}): Promise<void> {
  const qs = new URLSearchParams();
  if (opts.workerId) qs.set("worker_id", opts.workerId);
  if (opts.cwd) qs.set("cwd", opts.cwd);
  const path = qs.toString() ? `/v1/sessions?${qs}` : "/v1/sessions";
  const result = await hubRequest("GET", path);
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const body = result.body as { sessions?: Session[] };
  const rows = body.sessions ?? [];
  if (rows.length === 0) {
    console.log("(no sessions)");
    return;
  }
  for (const s of rows) {
    const stamp = new Date(s.last_activity_at).toISOString().replace("T", " ").slice(0, 19);
    const label = s.label ? ` "${s.label}"` : "";
    console.log(`${s.status.padEnd(10)} ${s.session_id.slice(0, 8)}  ${s.agent.padEnd(8)} ${s.cwd}${label}`);
    console.log(`           tmux=${s.tmux_name}  last=${stamp}`);
  }
}

export async function runSessionAttach(sessionIdPrefix: string): Promise<void> {
  const result = await hubRequest("GET", "/v1/sessions");
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const body = result.body as { sessions?: Session[] };
  const rows = body.sessions ?? [];
  const match = rows.find((s) => s.session_id.startsWith(sessionIdPrefix));
  if (!match) {
    console.error(`no session matches '${sessionIdPrefix}'`);
    process.exitCode = 1;
    return;
  }
  console.log(`attaching to ${match.tmux_name} (Ctrl-B then D to detach)`);
  const child = spawn("tmux", ["attach", "-t", `=${match.tmux_name}`], {
    stdio: "inherit",
  });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tmux exited ${code}`))));
    child.on("error", reject);
  });
}

export async function runSessionKill(sessionIdPrefix: string): Promise<void> {
  const result = await hubRequest("GET", "/v1/sessions");
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const body = result.body as { sessions?: Session[] };
  const rows = body.sessions ?? [];
  const match = rows.find((s) => s.session_id.startsWith(sessionIdPrefix));
  if (!match) {
    console.error(`no session matches '${sessionIdPrefix}'`);
    process.exitCode = 1;
    return;
  }
  const del = await hubRequest("DELETE", `/v1/sessions/${encodeURIComponent(match.session_id)}`);
  if (del.status >= 400) {
    console.error(`error: hub returned ${del.status}: ${JSON.stringify(del.body)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`killed ${match.tmux_name}`);
}

export async function runSessionSend(sessionIdPrefix: string, text: string, opts: { noEnter?: boolean }): Promise<void> {
  const result = await hubRequest("GET", "/v1/sessions");
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const body = result.body as { sessions?: Session[] };
  const rows = body.sessions ?? [];
  const match = rows.find((s) => s.session_id.startsWith(sessionIdPrefix));
  if (!match) {
    console.error(`no session matches '${sessionIdPrefix}'`);
    process.exitCode = 1;
    return;
  }
  const sendResult = await hubRequest(
    "POST",
    `/v1/sessions/${encodeURIComponent(match.session_id)}/input`,
    { text, press_enter: !opts.noEnter },
  );
  if (sendResult.status >= 400) {
    console.error(`error: hub returned ${sendResult.status}: ${JSON.stringify(sendResult.body)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`sent to ${match.tmux_name}`);
}

export async function runSessionCapture(sessionIdPrefix: string, opts: { since?: string }): Promise<void> {
  const result = await hubRequest("GET", "/v1/sessions");
  if (result.status >= 400) {
    console.error(`error: hub returned ${result.status}: ${JSON.stringify(result.body)}`);
    process.exitCode = 1;
    return;
  }
  const body = result.body as { sessions?: Session[] };
  const rows = body.sessions ?? [];
  const match = rows.find((s) => s.session_id.startsWith(sessionIdPrefix));
  if (!match) {
    console.error(`no session matches '${sessionIdPrefix}'`);
    process.exitCode = 1;
    return;
  }
  const qs = opts.since ? `?since=${encodeURIComponent(opts.since)}` : "";
  const capture = await hubRequest("GET", `/v1/sessions/${encodeURIComponent(match.session_id)}/capture${qs}`);
  if (capture.status >= 400) {
    console.error(`error: hub returned ${capture.status}: ${JSON.stringify(capture.body)}`);
    process.exitCode = 1;
    return;
  }
  const data = capture.body as { text: string; cursor: number; full: boolean };
  process.stdout.write(data.text);
  if (!data.text.endsWith("\n")) process.stdout.write("\n");
  console.error(`--- cursor=${data.cursor}${data.full ? " (truncated)" : ""} ---`);
}
