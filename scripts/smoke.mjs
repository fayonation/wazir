#!/usr/bin/env node
// End-to-end smoke test: hub + worker + CLI adapter, drive an approval.
import { startHub } from "../packages/hub/dist/index.js";
import { startWorker } from "../packages/worker/dist/index.js";
import { CliAdapter } from "../packages/adapter-cli/dist/index.js";
import { DEFAULT_RISK_PATTERNS, generateHmacSecret } from "../packages/protocol/dist/index.js";
import { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let exitCode = 0;
const tmp = mkdtempSync(join(tmpdir(), "wazir-smoke-"));
const hmacSecret = generateHmacSecret();

// In-memory stdin/stdout for the CLI adapter so we can drive it programmatically.
const cliIn = new Readable({ read() {} });
let cliOut = "";
const cliWriter = new Writable({
  write(chunk, _enc, cb) {
    cliOut += chunk.toString();
    cb();
  },
});

const adapter = new CliAdapter({ input: cliIn, output: cliWriter, actor: "smoke" });

const hub = await startHub({
  bindHost: "127.0.0.1",
  bindPort: 0, // random free port
  dbPath: join(tmp, "hub.db"),
  hmacSecret,
  adapters: [adapter],
});
console.log("hub up at", hub.url);

const worker = await startWorker({
  workerId: "smoke-worker",
  bindHost: "127.0.0.1",
  bindPort: 0,
  hubUrl: hub.url,
  hmacSecret,
  hostname: "smoke-host",
  version: "0.1.0-smoke",
  riskPatterns: DEFAULT_RISK_PATTERNS,
  heartbeatIntervalMs: 60_000,
  approvalTimeoutSeconds: 10,
});
console.log("worker up at", worker.url);

// Reach into CLI adapter's pending approval and approve it as soon as it arrives.
const seenApprovals = new Set();
const watch = setInterval(() => {
  // adapter has a private "pending" map; we drive it via stdin instead.
  const matches = cliOut.match(/\[approval ([0-9a-f-]+)\]/g) ?? [];
  for (const m of matches) {
    const id = m.replace("[approval ", "").replace("]", "");
    if (!seenApprovals.has(id)) {
      seenApprovals.add(id);
      console.log("approving", id);
      cliIn.push(`approve ${id}\n`);
    }
  }
}, 50);

try {
  // Hit the worker like Claude Code would.
  const hookResponse = await fetch(`${worker.url}/v1/hooks/claude-code/pre-tool-use`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "smoke-session",
      cwd: "/tmp/smoke",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin main", description: "smoke push" },
    }),
  });
  const body = await hookResponse.json();
  console.log("hook response:", JSON.stringify(body));

  if (body?.hookSpecificOutput?.permissionDecision !== "allow") {
    console.error("FAIL: expected permissionDecision=allow for approved push");
    exitCode = 1;
  } else {
    console.log("OK: approve flow returned permissionDecision=allow");
  }

  // Second scenario: a safe command should pass without approval.
  const safe = await fetch(`${worker.url}/v1/hooks/claude-code/pre-tool-use`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "smoke-session",
      cwd: "/tmp/smoke",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    }),
  });
  const safeBody = await safe.json();
  if (safeBody?.hookSpecificOutput?.permissionDecision !== "allow") {
    console.error("FAIL: safe command should auto-allow");
    exitCode = 1;
  } else if (seenApprovals.size > 1) {
    console.error(`FAIL: safe command triggered an approval (saw ${seenApprovals.size} approvals)`);
    exitCode = 1;
  } else {
    console.log("OK: safe command auto-allowed (no approval prompt)");
  }
} finally {
  clearInterval(watch);
  await worker.stop();
  await hub.stop();
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exitCode);
