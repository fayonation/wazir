#!/usr/bin/env node
// One-shot: move Wazir secrets from the OS keychain into ~/.wazir/.env, then
// delete the keychain entries. After this runs once successfully, keytar can
// be removed as a dependency (the project no longer needs it).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV = resolve(homedir(), ".wazir", ".env");
const SERVICE = "wazir";
const ACCOUNTS = [
  { account: "hmac-secret", envVar: "WAZIR_HMAC_SECRET" },
  { account: "telegram-token", envVar: "WAZIR_TELEGRAM_TOKEN" },
];

// pnpm workspaces hoist deps per package; keytar lives under packages/cli's
// node_modules. Build a require rooted there.
const repoRoot = resolve(__dirname, "..");
const requireFromCli = createRequire(resolve(repoRoot, "packages/cli/package.json"));
let keytar;
try {
  keytar = requireFromCli("keytar");
} catch (err) {
  console.error(`keytar load failed: ${err.message}`);
  console.error("If you've already removed the keytar dep, nothing to migrate — exiting cleanly.");
  process.exit(0);
}

function envHas(envText, key) {
  return envText.split(/\r?\n/).some((line) => line.startsWith(`${key}=`));
}

let envText = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";

for (const { account, envVar } of ACCOUNTS) {
  let value;
  try {
    value = await keytar.getPassword(SERVICE, account);
  } catch (err) {
    console.error(`could not read ${account} from keychain: ${err.message}`);
    continue;
  }
  if (!value) {
    console.log(`(${account} not in keychain — skip)`);
    continue;
  }
  if (envHas(envText, envVar)) {
    console.log(`${envVar} already in ${ENV} — leaving the file untouched`);
  } else {
    if (envText && !envText.endsWith("\n")) appendFileSync(ENV, "\n");
    appendFileSync(ENV, `${envVar}=${value}\n`, { mode: 0o600 });
    envText += `${envVar}=${value}\n`;
    console.log(`appended ${envVar} to ${ENV}`);
  }
  try {
    await keytar.deletePassword(SERVICE, account);
    console.log(`deleted ${account} from keychain`);
  } catch (err) {
    console.error(`could not delete ${account} from keychain: ${err.message}`);
  }
}

console.log("done.");
