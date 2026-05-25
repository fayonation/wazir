import { readFileSync, existsSync } from "node:fs";
import { KEYCHAIN_SERVICE, ENV_FILE_PATH } from "./paths.js";

interface KeytarApi {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

let keytarPromise: Promise<KeytarApi | null> | null = null;

async function loadKeytar(): Promise<KeytarApi | null> {
  if (keytarPromise) return keytarPromise;
  keytarPromise = (async () => {
    try {
      const mod = (await import("keytar")) as unknown as KeytarApi & { default?: KeytarApi };
      const api: KeytarApi = mod.default ?? mod;
      // touch the native binding to fail fast if missing
      await api.findCredentials(KEYCHAIN_SERVICE);
      return api;
    } catch {
      return null;
    }
  })();
  return keytarPromise;
}

export async function setKeychain(account: string, value: string): Promise<boolean> {
  const k = await loadKeytar();
  if (!k) return false;
  await k.setPassword(KEYCHAIN_SERVICE, account, value);
  return true;
}

export async function getKeychain(account: string): Promise<string | null> {
  const k = await loadKeytar();
  if (!k) return null;
  return k.getPassword(KEYCHAIN_SERVICE, account);
}

export async function deleteKeychain(account: string): Promise<boolean> {
  const k = await loadKeytar();
  if (!k) return false;
  return k.deletePassword(KEYCHAIN_SERVICE, account);
}

export function loadDotEnv(path = ENV_FILE_PATH): Record<string, string> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function mergeDotEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

export async function resolveTelegramToken(
  envVarName: string,
  useKeychain: boolean,
  keychainAccount: string,
): Promise<string | null> {
  if (useKeychain) {
    const fromKc = await getKeychain(keychainAccount);
    if (fromKc) return fromKc;
  }
  const fromEnv = process.env[envVarName];
  return fromEnv ?? null;
}

export async function resolveHmacSecret(envVarName = "WAZIR_HMAC_SECRET"): Promise<string | null> {
  const fromKc = await getKeychain("hmac-secret");
  if (fromKc) return fromKc;
  const fromEnv = process.env[envVarName];
  return fromEnv ?? null;
}
