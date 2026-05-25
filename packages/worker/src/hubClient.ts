import {
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
  signPayload,
  type ApprovalRequest,
  type Session,
  type WorkerRegistration,
} from "@wazir/protocol";

export class HubClient {
  constructor(
    private readonly hubUrl: string,
    private readonly hmacSecret: string,
  ) {}

  async register(reg: WorkerRegistration, opts: { retries?: number; baseDelayMs?: number } = {}): Promise<void> {
    const retries = opts.retries ?? 10;
    const baseDelay = opts.baseDelayMs ?? 250;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.post("/v1/workers", reg);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const delay = Math.min(baseDelay * 2 ** attempt, 3000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error
      ? new Error(`hub unreachable after ${retries + 1} attempts: ${lastErr.message}`)
      : lastErr;
  }

  async heartbeat(workerId: string): Promise<void> {
    await this.post(`/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, {
      worker_id: workerId,
      ts: Math.floor(Date.now() / 1000),
    });
  }

  async submitApproval(req: ApprovalRequest): Promise<{ approval_id: string }> {
    const res = await this.post("/v1/approvals", req);
    return res as { approval_id: string };
  }

  async reportSessions(workerId: string, sessions: Session[]): Promise<void> {
    await this.post(`/v1/workers/${encodeURIComponent(workerId)}/sessions`, { sessions });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(this.hmacSecret, raw, ts);
    const response = await fetch(`${this.hubUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HMAC_HEADER_SIGNATURE]: sig,
        [HMAC_HEADER_TIMESTAMP]: String(ts),
      },
      body: raw,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`hub ${path} returned ${response.status}: ${text}`);
    }
    return (await response.json()) as unknown;
  }
}
