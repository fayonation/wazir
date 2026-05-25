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
import {
  runInstallService,
  runUninstallService,
  runServiceStatus,
  runServiceRestart,
} from "./commands/service.js";

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
