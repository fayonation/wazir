import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";
import { signPayload, HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP } from "@wazir/protocol";

interface StatusOptions {
  json?: boolean;
}

export async function runStatus(opts: StatusOptions = {}): Promise<void> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const hmacSecret = await resolveHmacSecret();
  const hubUrl = config.hub.url ?? `http://${config.hub.bind_host}:${config.hub.bind_port}`;
  const workerUrl = `http://${config.worker.bind_host}:${config.worker.bind_port}`;

  const [hubHealth, workerHealth, approvals] = await Promise.all([
    checkHealth(`${hubUrl}/v1/health`),
    checkHealth(`${workerUrl}/v1/health`),
    hmacSecret ? recentApprovals(hubUrl, hmacSecret, 5) : Promise.resolve<unknown[] | null>(null),
  ]);

  if (opts.json) {
    console.log(JSON.stringify({ hub: hubHealth, worker: workerHealth, approvals }, null, 2));
    return;
  }

  console.log(`hub      ${formatHealth(hubHealth)}    ${hubUrl}`);
  console.log(`worker   ${formatHealth(workerHealth)}    ${workerUrl}`);
  console.log();
  if (approvals && approvals.length > 0) {
    console.log("recent approvals:");
    for (const a of approvals as ApprovalRowLike[]) {
      const time = new Date(a.created_at).toISOString().replace("T", " ").slice(0, 19);
      const status = a.status === "decided" ? (a.decision ?? "?") : a.status;
      const cmd = a.command.length > 60 ? `${a.command.slice(0, 57)}...` : a.command;
      console.log(`  [${time}] ${status.padEnd(8)} ${cmd}`);
    }
  } else if (approvals) {
    console.log("recent approvals: (none)");
  } else {
    console.log("recent approvals: unavailable (no HMAC secret)");
  }
}

interface ApprovalRowLike {
  approval_id: string;
  command: string;
  status: string;
  decision: string | null;
  created_at: number;
}

interface HealthStatus {
  ok: boolean;
  detail?: unknown;
  error?: string;
}

async function checkHealth(url: string): Promise<HealthStatus> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const detail = (await res.json()) as unknown;
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function recentApprovals(hubUrl: string, hmacSecret: string, limit: number): Promise<ApprovalRowLike[] | null> {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(hmacSecret, "", ts);
    const res = await fetch(`${hubUrl}/v1/approvals?limit=${limit}`, {
      headers: {
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { approvals: ApprovalRowLike[] };
    return body.approvals;
  } catch {
    return null;
  }
}

function formatHealth(h: HealthStatus): string {
  return h.ok ? "ok  " : `down (${h.error ?? "unknown"})`;
}
