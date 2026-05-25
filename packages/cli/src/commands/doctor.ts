import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../config.js";
import { resolveHmacSecret, resolveTelegramToken, loadDotEnv, mergeDotEnv } from "../secrets.js";
import { CONFIG_PATH, KEYCHAIN_TELEGRAM_ACCOUNT } from "../paths.js";
import { HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP, signPayload } from "@wazir/protocol";

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const SUPPORTED_NODE_MAJORS = new Set([20, 22]);

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  checks.push(checkNodeVersion());

  const configCheck = checkConfigPresent();
  checks.push(configCheck);

  if (!configCheck.pass) {
    print(checks);
    process.exitCode = 1;
    return;
  }

  mergeDotEnv(loadDotEnv());
  let cfg;
  try {
    cfg = loadConfig();
    checks.push({ name: "config valid", pass: true });
  } catch (err) {
    checks.push({ name: "config valid", pass: false, detail: (err as Error).message });
    print(checks);
    process.exitCode = 1;
    return;
  }

  const hubUrl = cfg.hub.url ?? `http://${cfg.hub.bind_host}:${cfg.hub.bind_port}`;
  const workerUrl = `http://${cfg.worker.bind_host}:${cfg.worker.bind_port}`;

  const hmacSecret = await resolveHmacSecret();
  checks.push({
    name: "HMAC secret available",
    pass: Boolean(hmacSecret),
    detail: hmacSecret ? undefined : "neither keychain nor WAZIR_HMAC_SECRET env var has the secret",
  });

  checks.push(await checkHttp("hub reachable", `${hubUrl}/v1/health`));
  checks.push(await checkHttp("worker reachable", `${workerUrl}/v1/health`));

  const telegramAdapter = cfg.adapters.find((a) => a.name === "telegram" && a.enabled);
  if (telegramAdapter && telegramAdapter.name === "telegram") {
    const token = await resolveTelegramToken(
      telegramAdapter.config.token_env,
      Boolean(telegramAdapter.config.token_keychain_account),
      telegramAdapter.config.token_keychain_account ?? KEYCHAIN_TELEGRAM_ACCOUNT,
    );
    if (!token) {
      checks.push({ name: "telegram token", pass: false, detail: "token not found in keychain or env" });
    } else {
      checks.push({ name: "telegram token", pass: true });
      checks.push(await checkTelegramReachable(token));
    }
    checks.push({
      name: "telegram allowlist populated",
      pass: telegramAdapter.config.allowlist.length > 0,
      detail:
        telegramAdapter.config.allowlist.length === 0
          ? "approvals will silently drop with an empty allowlist"
          : `${telegramAdapter.config.allowlist.length} chat id(s)`,
    });
  }

  checks.push(checkClaudeHookSnippet(cfg.worker.bind_port));

  print(checks);
  if (!checks.every((c) => c.pass)) process.exitCode = 1;
}

function checkNodeVersion(): Check {
  const [majorStr] = process.versions.node.split(".");
  const major = Number.parseInt(majorStr ?? "0", 10);
  if (SUPPORTED_NODE_MAJORS.has(major)) {
    return { name: "Node version", pass: true, detail: `v${process.versions.node}` };
  }
  return {
    name: "Node version",
    pass: false,
    detail: `v${process.versions.node} (need Node 20 or 22 — run 'nvm use')`,
  };
}

function checkConfigPresent(): Check {
  return {
    name: "config file present",
    pass: existsSync(CONFIG_PATH),
    detail: existsSync(CONFIG_PATH) ? CONFIG_PATH : `${CONFIG_PATH} — run 'pnpm wazir:init'`,
  };
}

async function checkHttp(name: string, url: string): Promise<Check> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { name, pass: false, detail: `${url} returned ${res.status}` };
    return { name, pass: true, detail: url };
  } catch (err) {
    return { name, pass: false, detail: `${url} — ${(err as Error).message}` };
  }
}

async function checkTelegramReachable(token: string): Promise<Check> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { name: "telegram bot reachable", pass: false, detail: `getMe returned ${res.status}` };
    }
    const body = (await res.json()) as { ok: boolean; result?: { username?: string; first_name?: string } };
    if (!body.ok) {
      return { name: "telegram bot reachable", pass: false, detail: "getMe returned ok=false" };
    }
    const name = body.result?.username ?? body.result?.first_name ?? "unknown";
    return { name: "telegram bot reachable", pass: true, detail: `@${name}` };
  } catch (err) {
    return { name: "telegram bot reachable", pass: false, detail: (err as Error).message };
  }
}

function checkClaudeHookSnippet(expectedWorkerPort: number): Check {
  const settingsPath = resolve(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return {
      name: "claude code hook installed",
      pass: false,
      detail: `${settingsPath} not found`,
    };
  }
  try {
    const text = readFileSync(settingsPath, "utf8");
    const json = JSON.parse(text) as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; url?: string }> }> } };
    const preToolUse = json.hooks?.PreToolUse;
    if (!preToolUse || !Array.isArray(preToolUse)) {
      return { name: "claude code hook installed", pass: false, detail: "no PreToolUse hooks in ~/.claude/settings.json" };
    }
    const expectedUrl = `http://127.0.0.1:${expectedWorkerPort}/v1/hooks/claude-code/pre-tool-use`;
    const found = preToolUse.some((entry) =>
      (entry.hooks ?? []).some((h) => h.type === "http" && h.url === expectedUrl),
    );
    return {
      name: "claude code hook installed",
      pass: found,
      detail: found ? expectedUrl : `expected url not found: ${expectedUrl}`,
    };
  } catch (err) {
    return { name: "claude code hook installed", pass: false, detail: (err as Error).message };
  }
}

function print(checks: Check[]): void {
  console.log();
  for (const c of checks) {
    const mark = c.pass ? "✓" : "✗";
    const line = `${mark} ${c.name.padEnd(32)} ${c.detail ?? ""}`;
    if (c.pass) console.log(line);
    else console.error(line);
  }
  console.log();
  const failed = checks.filter((c) => !c.pass).length;
  if (failed === 0) {
    console.log("all checks passed.");
  } else {
    console.log(`${failed} check(s) failed.`);
  }
}
