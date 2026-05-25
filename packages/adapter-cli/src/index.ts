import { createInterface, type Interface } from "node:readline";
import type {
  AdapterHandlers,
  HubNotification,
  InterfaceAdapter,
  UserDecision,
} from "@wazir/protocol";

export interface CliAdapterOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  actor?: string;
}

export class CliAdapter implements InterfaceAdapter {
  readonly name = "cli";

  private rl: Interface | null = null;
  private handlers: AdapterHandlers | null = null;
  private pending = new Map<string, HubNotification>();
  private readonly actor: string;
  private readonly output: NodeJS.WritableStream;
  private readonly input: NodeJS.ReadableStream;

  constructor(opts: CliAdapterOptions = {}) {
    this.actor = opts.actor ?? `cli:${process.pid}`;
    this.output = opts.output ?? process.stdout;
    this.input = opts.input ?? process.stdin;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.rl = createInterface({ input: this.input, output: this.output, terminal: false });
    this.rl.on("line", (line) => {
      this.handleLine(line.trim()).catch((err) => {
        this.write(`error: ${(err as Error).message}\n`);
      });
    });
    this.write("[cli-adapter] ready. commands: approve <id> | reject <id> | modify <id> <command>\n");
  }

  async sendNotification(n: HubNotification): Promise<void> {
    this.pending.set(n.approval_id, n);
    this.write(
      [
        "─".repeat(60),
        `[approval ${n.approval_id}] ${n.title}`,
        n.body,
        `actions: ${n.actions.map((a) => a.id).join(" | ")}`,
        "─".repeat(60),
        "",
      ].join("\n"),
    );
  }

  async cancelNotification(approvalId: string, reason: string): Promise<void> {
    if (this.pending.delete(approvalId)) {
      this.write(`[approval ${approvalId}] cancelled (${reason})\n`);
    }
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
    this.pending.clear();
  }

  private write(text: string): void {
    this.output.write(text);
  }

  private async handleLine(line: string): Promise<void> {
    if (!line || !this.handlers) return;
    const parts = line.split(/\s+/);
    const verb = parts[0]?.toLowerCase();
    const approvalId = parts[1];
    if (!verb || !approvalId) {
      this.write("usage: approve <id> | reject <id> | modify <id> <command>\n");
      return;
    }
    if (!this.pending.has(approvalId)) {
      this.write(`unknown approval id: ${approvalId}\n`);
      return;
    }
    let decision: UserDecision;
    if (verb === "approve") {
      decision = { action: "approve", actor: this.actor };
    } else if (verb === "reject") {
      decision = { action: "reject", actor: this.actor };
    } else if (verb === "modify") {
      const modified = parts.slice(2).join(" ").trim();
      if (!modified) {
        this.write("usage: modify <id> <command>\n");
        return;
      }
      decision = { action: "modify", actor: this.actor, modified_command: modified };
    } else {
      this.write(`unknown verb: ${verb}\n`);
      return;
    }
    this.pending.delete(approvalId);
    await this.handlers.onDecision(approvalId, decision);
    this.write(`[approval ${approvalId}] ${decision.action} sent\n`);
  }
}
