import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  writePlist,
  removePlist,
  bootstrap,
  bootout,
  kickstart,
  status,
  plistPath,
  ensureLogDir,
  type LaunchAgentSpec,
} from "../service/launchd.js";

const HUB_LABEL = "com.wazir.hub";
const WORKER_LABEL = "com.wazir.worker";

function repoRoot(): string {
  // dist/commands/service.js lives at packages/cli/dist/commands/service.js
  // the repo root is four levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

function buildSpecs(): { hub: LaunchAgentSpec; worker: LaunchAgentSpec } {
  if (process.platform !== "darwin") {
    throw new Error(
      "service commands currently support macOS only. Linux (systemd) support is a Phase 1.5 follow-up.",
    );
  }
  const node = process.execPath; // absolute path to the Node binary running us
  if (!node || !existsSync(node)) {
    throw new Error(`could not resolve the active Node binary (process.execPath=${node})`);
  }
  const root = repoRoot();
  const binJs = resolve(root, "packages/cli/dist/bin.js");
  if (!existsSync(binJs)) {
    throw new Error(
      `compiled CLI not found at ${binJs}. Run 'pnpm build' before installing the service.`,
    );
  }
  const logsDir = resolve(homedir(), ".wazir", "logs");
  const hubLog = resolve(logsDir, "hub.log");
  const workerLog = resolve(logsDir, "worker.log");
  ensureLogDir(hubLog);
  ensureLogDir(workerLog);

  const sharedEnv: Record<string, string> = {
    // Include ~/.local/bin because that's where Claude Code installs the
    // `claude` binary by default. Without it the worker can't spawn the
    // print-mode runner ("spawn claude ENOENT").
    PATH: `${homedir()}/.local/bin:${dirname(node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    HOME: homedir(),
  };

  return {
    hub: {
      label: HUB_LABEL,
      programArguments: [node, binJs, "hub"],
      workingDirectory: root,
      stdoutPath: hubLog,
      stderrPath: hubLog,
      envExtras: sharedEnv,
      keepAlive: true,
      runAtLoad: true,
    },
    worker: {
      label: WORKER_LABEL,
      programArguments: [node, binJs, "worker"],
      workingDirectory: root,
      stdoutPath: workerLog,
      stderrPath: workerLog,
      envExtras: sharedEnv,
      keepAlive: true,
      runAtLoad: true,
    },
  };
}

export async function runInstallService(opts: { force?: boolean } = {}): Promise<void> {
  const specs = buildSpecs();
  for (const spec of [specs.hub, specs.worker]) {
    const path = plistPath(spec.label);
    if (existsSync(path) && !opts.force) {
      console.log(`already installed: ${path} (use --force to overwrite)`);
    } else {
      const written = writePlist(spec);
      console.log(`wrote ${written}`);
    }
    try {
      // bootout first in case it's already loaded; ignore errors when not loaded
      try { bootout(spec.label); } catch { /* not loaded */ }
      bootstrap(spec.label);
      console.log(`loaded ${spec.label}`);
    } catch (err) {
      console.error(`failed to load ${spec.label}: ${(err as Error).message}`);
      throw err;
    }
  }
  console.log("\n✅ services installed and running.");
  console.log("  hub:    com.wazir.hub");
  console.log("  worker: com.wazir.worker");
  console.log("  logs:   ~/.wazir/logs/{hub,worker}.log");
  console.log("\nThe services will auto-start at login and restart on crash.");
  console.log("Use 'wazir service status' to check, 'wazir uninstall-service' to remove.");
}

export async function runUninstallService(): Promise<void> {
  for (const label of [WORKER_LABEL, HUB_LABEL]) {
    try {
      bootout(label);
      console.log(`unloaded ${label}`);
    } catch (err) {
      console.log(`${label} was not loaded`);
    }
    if (removePlist(label)) {
      console.log(`removed ${plistPath(label)}`);
    }
  }
  console.log("\n✅ services uninstalled.");
}

export async function runServiceStatus(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("service status currently supports macOS only");
    process.exitCode = 1;
    return;
  }
  for (const label of [HUB_LABEL, WORKER_LABEL]) {
    const s = status(label);
    const loaded = s.loaded ? "loaded" : "not loaded";
    const pid = s.pid !== null ? `pid=${s.pid}` : "pid=-";
    const exit = s.lastExitStatus !== null ? `last exit=${s.lastExitStatus}` : "";
    console.log(`${label.padEnd(20)} ${loaded.padEnd(10)} ${pid.padEnd(10)} ${exit}`);
  }
}

export async function runServiceRestart(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("service restart currently supports macOS only");
    process.exitCode = 1;
    return;
  }
  for (const label of [HUB_LABEL, WORKER_LABEL]) {
    try {
      kickstart(label);
      console.log(`restarted ${label}`);
    } catch (err) {
      console.error(`failed to restart ${label}: ${(err as Error).message}`);
    }
  }
}
