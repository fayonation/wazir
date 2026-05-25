import { loadConfig } from "../config.js";
import { resolveHmacSecret, loadDotEnv, mergeDotEnv } from "../secrets.js";
import { signPayload, HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP } from "@wazir/protocol";

export async function runLog(opts: { limit?: string } = {}): Promise<void> {
  mergeDotEnv(loadDotEnv());
  const config = loadConfig();
  const hmacSecret = await resolveHmacSecret();
  if (!hmacSecret) {
    console.error("error: HMAC secret missing. Cannot query hub.");
    process.exitCode = 1;
    return;
  }
  const hubUrl = config.hub.url ?? `http://${config.hub.bind_host}:${config.hub.bind_port}`;
  const limit = Number.parseInt(opts.limit ?? "20", 10);
  const ts = Math.floor(Date.now() / 1000);
  const sig = signPayload(hmacSecret, "", ts);
  try {
    const res = await fetch(`${hubUrl}/v1/approvals?limit=${limit}`, {
      headers: {
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.error(`hub returned ${res.status}`);
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as { approvals: Array<{
      approval_id: string;
      command: string;
      status: string;
      decision: string | null;
      actor: string | null;
      created_at: number;
      decided_at: number | null;
    }>; };
    for (const a of body.approvals) {
      const time = new Date(a.created_at).toISOString().replace("T", " ").slice(0, 19);
      const status = a.status === "decided" ? (a.decision ?? "?") : a.status;
      const actor = a.actor ? ` by ${a.actor}` : "";
      console.log(`[${time}] ${status.padEnd(9)} ${a.command}${actor}`);
    }
  } catch (err) {
    console.error(`hub unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
