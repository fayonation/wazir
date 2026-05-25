import type { HubNotification } from "./notification.js";
import type { UserDecision } from "./approval.js";

export type DecisionHandler = (approvalId: string, decision: UserDecision) => Promise<void>;

export interface InterfaceAdapter {
  readonly name: string;

  start(handlers: AdapterHandlers): Promise<void>;

  sendNotification(n: HubNotification): Promise<void>;

  cancelNotification?(approvalId: string, reason: string): Promise<void>;

  stop(): Promise<void>;
}

export interface AdapterHandlers {
  onDecision: DecisionHandler;
}
