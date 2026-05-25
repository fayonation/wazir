import type { HubLogger } from "./logger.js";

export interface PendingApproval {
  approvalId: string;
  callbackUrl: string;
  workerId: string;
  command: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class PendingApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly logger: HubLogger,
    private readonly onTimeout: (approvalId: string) => Promise<void>,
  ) {}

  track(approvalId: string, callbackUrl: string, workerId: string, command: string, timeoutMs: number): void {
    const expiresAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => {
      this.pending.delete(approvalId);
      this.onTimeout(approvalId).catch((err) =>
        this.logger.error({ err, approval_id: approvalId }, "timeout handler failed"),
      );
    }, timeoutMs);
    timer.unref();
    this.pending.set(approvalId, { approvalId, callbackUrl, workerId, command, expiresAt, timer });
  }

  resolve(approvalId: string): PendingApproval | undefined {
    const entry = this.pending.get(approvalId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    return entry;
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  clearAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
