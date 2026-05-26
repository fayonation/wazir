#!/usr/bin/env node
import { preflight } from "./preflight.js";
preflight();

import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runHub } from "./commands/hub.js";
import { runWorker } from "./commands/worker.js";
import { runStatus } from "./commands/status.js";
import { runLog } from "./commands/log.js";
import { runDoctor } from "./commands/doctor.js";
import { runInstallModels } from "./commands/installModels.js";
import {
  runInstallService,
  runUninstallService,
  runServiceStatus,
  runServiceRestart,
} from "./commands/service.js";
import {
  runSessionNew,
  runSessionList,
  runSessionAttach,
  runSessionKill,
  runSessionSend,
  runSessionCapture,
} from "./commands/session.js";
import {
  runApprovalPending,
  runApprovalApprove,
  runApprovalReject,
  runApprovalModify,
} from "./commands/approval.js";

const program = new Command();

program
  .name("wazir")
  .description("Wazir — a local-first supervisor for AI coding agents")
  .version("0.1.0");

program
  .command("init")
  .description("Interactive setup wizard. Creates ~/.wazir/config.yaml.")
  .option("--force", "overwrite an existing config without confirmation")
  .action(async (opts) => {
    await runInit({ force: Boolean(opts.force) });
  });

program
  .command("hub")
  .description("Run the hub daemon (foreground).")
  .action(async () => {
    await runHub();
  });

program
  .command("worker")
  .description("Run the worker daemon (foreground).")
  .action(async () => {
    await runWorker();
  });

program
  .command("status")
  .description("Show hub/worker health and recent approvals.")
  .option("--json", "emit JSON instead of a human-readable summary")
  .action(async (opts) => {
    await runStatus({ json: Boolean(opts.json) });
  });

program
  .command("log")
  .description("Print recent approval history.")
  .option("--limit <n>", "how many records to show", "20")
  .action(async (opts) => {
    await runLog({ limit: opts.limit });
  });

program
  .command("doctor")
  .description("Run a health check (Node version, config, hub, worker, Telegram, hook).")
  .action(async () => {
    await runDoctor();
  });

program
  .command("install-models")
  .description("Install local STT dependencies (whisper.cpp via brew + base.en model).")
  .action(async () => {
    await runInstallModels();
  });

const session = program.command("session").description("Manage agent sessions (tmux-backed).");

session
  .command("new <agent>")
  .description("Spawn a new agent session (defaults: agent=claude, cwd=$PWD).")
  .option("--cwd <path>", "working directory for the agent")
  .option("--label <text>", "human label for the session")
  .action(async (agent: string, opts: { cwd?: string; label?: string }) => {
    const args: { cwd?: string; label?: string } = {};
    if (opts.cwd) args.cwd = opts.cwd;
    if (opts.label) args.label = opts.label;
    await runSessionNew(agent, args);
  });

session
  .command("list")
  .description("List sessions tracked by the hub.")
  .option("--worker <id>", "filter by worker id")
  .option("--cwd <path>", "filter by cwd")
  .action(async (opts: { worker?: string; cwd?: string }) => {
    const args: { workerId?: string; cwd?: string } = {};
    if (opts.worker) args.workerId = opts.worker;
    if (opts.cwd) args.cwd = opts.cwd;
    await runSessionList(args);
  });

session
  .command("attach <id-prefix>")
  .description("Attach a terminal to the session's tmux pane (Ctrl-B D to detach).")
  .action(async (idPrefix: string) => {
    await runSessionAttach(idPrefix);
  });

session
  .command("kill <id-prefix>")
  .description("Kill a session's tmux pane and drop it from the registry.")
  .action(async (idPrefix: string) => {
    await runSessionKill(idPrefix);
  });

session
  .command("send <id-prefix> <text...>")
  .description("Type text into a session (debug helper — Phase 2 voice handler does this for real).")
  .option("--no-enter", "do not press Enter after the text")
  .action(async (idPrefix: string, textParts: string[], opts: { noEnter?: boolean }) => {
    await runSessionSend(idPrefix, textParts.join(" "), { noEnter: Boolean(opts.noEnter) });
  });

session
  .command("capture <id-prefix>")
  .description("Read the session's tmux pane buffer.")
  .option("--since <cursor>", "byte offset to start from (default: per-session delta cursor)")
  .action(async (idPrefix: string, opts: { since?: string }) => {
    const args: { since?: string } = {};
    if (opts.since) args.since = opts.since;
    await runSessionCapture(idPrefix, args);
  });

program
  .command("pending")
  .description("List pending approvals (waiting for a decision).")
  .action(async () => {
    await runApprovalPending();
  });

program
  .command("approve [id-prefix]")
  .description("Approve a pending approval. Omits the id if exactly one is pending.")
  .action(async (idPrefix: string | undefined) => {
    await runApprovalApprove(idPrefix);
  });

program
  .command("reject [id-prefix]")
  .description("Reject a pending approval. Omits the id if exactly one is pending.")
  .action(async (idPrefix: string | undefined) => {
    await runApprovalReject(idPrefix);
  });

program
  .command("modify <id-prefix> <new-command...>")
  .description("Approve with a modified command (will run instead of the original).")
  .action(async (idPrefix: string, parts: string[]) => {
    await runApprovalModify(idPrefix, parts.join(" "));
  });

program
  .command("install-service")
  .description("Install hub + worker as macOS LaunchAgents (auto-start on login).")
  .option("--force", "overwrite existing plists if present")
  .action(async (opts) => {
    await runInstallService({ force: Boolean(opts.force) });
  });

program
  .command("uninstall-service")
  .description("Remove hub + worker LaunchAgents.")
  .action(async () => {
    await runUninstallService();
  });

program
  .command("service")
  .description("Manage the installed LaunchAgents.")
  .argument("<action>", "status | restart")
  .action(async (action: string) => {
    if (action === "status") {
      await runServiceStatus();
    } else if (action === "restart") {
      await runServiceRestart();
    } else {
      console.error(`unknown service action: ${action} (expected 'status' or 'restart')`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = err as Error & { code?: string };
  if (process.env.WAZIR_DEBUG) {
    console.error(e.stack ?? e);
  } else {
    console.error(`error: ${e.message ?? String(e)}`);
    console.error("(set WAZIR_DEBUG=1 for a full stack trace)");
  }
  process.exit(1);
});
