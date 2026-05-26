import type { InterfaceAdapter, HubNotification, UserDecision, SessionService } from "@wazir/protocol";
import type { HubLogger } from "./logger.js";

export type DecisionRouter = (approvalId: string, decision: UserDecision) => Promise<void>;

export class AdapterRegistry {
  private readonly adapters: InterfaceAdapter[] = [];

  constructor(
    private readonly logger: HubLogger,
    private readonly onDecision: DecisionRouter,
    private readonly sessionService: SessionService | undefined,
  ) {}

  async register(adapter: InterfaceAdapter): Promise<void> {
    await adapter.start({
      onDecision: this.onDecision,
      ...(this.sessionService ? { sessions: this.sessionService } : {}),
    });
    this.adapters.push(adapter);
    this.logger.info({ adapter: adapter.name }, "adapter registered");
  }

  async broadcast(notification: HubNotification): Promise<void> {
    const errors: { adapter: string; err: unknown }[] = [];
    await Promise.all(
      this.adapters.map(async (a) => {
        try {
          await a.sendNotification(notification);
        } catch (err) {
          errors.push({ adapter: a.name, err });
          this.logger.error(
            { adapter: a.name, err, approval_id: notification.approval_id },
            "adapter sendNotification failed",
          );
        }
      }),
    );
    if (errors.length === this.adapters.length && this.adapters.length > 0) {
      throw new Error("all adapters failed to deliver notification");
    }
  }

  async cancel(approvalId: string, reason: string): Promise<void> {
    await Promise.all(
      this.adapters.map(async (a) => {
        if (!a.cancelNotification) return;
        try {
          await a.cancelNotification(approvalId, reason);
        } catch (err) {
          this.logger.warn({ adapter: a.name, err, approval_id: approvalId }, "adapter cancel failed");
        }
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      this.adapters.map(async (a) => {
        try {
          await a.stop();
        } catch (err) {
          this.logger.warn({ adapter: a.name, err }, "adapter stop failed");
        }
      }),
    );
    this.adapters.length = 0;
  }

  names(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
