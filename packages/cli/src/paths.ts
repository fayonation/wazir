import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandTilde(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

export const WAZIR_DIR = resolve(homedir(), ".wazir");
export const CONFIG_PATH = resolve(WAZIR_DIR, "config.yaml");
export const HOOK_SNIPPET_PATH = resolve(WAZIR_DIR, "claude-hook-snippet.json");
export const DEFAULT_DB_PATH = resolve(WAZIR_DIR, "hub.db");
export const ENV_FILE_PATH = resolve(WAZIR_DIR, ".env");
