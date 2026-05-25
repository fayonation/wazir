import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export interface LaunchAgentSpec {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  envExtras?: Record<string, string>;
  keepAlive?: boolean;
  runAtLoad?: boolean;
}

const LAUNCHD_DIR = resolve(homedir(), "Library", "LaunchAgents");

export function plistPath(label: string): string {
  return resolve(LAUNCHD_DIR, `${label}.plist`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderPlist(spec: LaunchAgentSpec): string {
  const args = spec.programArguments.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const envEntries = Object.entries(spec.envExtras ?? {})
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <${spec.runAtLoad === false ? "false" : "true"}/>
  <key>KeepAlive</key>
  <${spec.keepAlive === false ? "false" : "true"}/>
  <key>StandardOutPath</key>
  <string>${escapeXml(spec.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
${envBlock}</dict>
</plist>
`;
}

export function writePlist(spec: LaunchAgentSpec): string {
  mkdirSync(LAUNCHD_DIR, { recursive: true });
  const path = plistPath(spec.label);
  writeFileSync(path, renderPlist(spec), { encoding: "utf8", mode: 0o644 });
  return path;
}

export function removePlist(label: string): boolean {
  const path = plistPath(label);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function getUid(): string {
  return String(process.getuid?.() ?? 501);
}

function gui(label: string): string {
  return `gui/${getUid()}/${label}`;
}

export function bootstrap(label: string): { stdout: string; stderr: string } {
  return runLaunchctl(["bootstrap", `gui/${getUid()}`, plistPath(label)]);
}

export function bootout(label: string): { stdout: string; stderr: string } {
  return runLaunchctl(["bootout", gui(label)]);
}

export function kickstart(label: string): { stdout: string; stderr: string } {
  return runLaunchctl(["kickstart", "-k", gui(label)]);
}

export interface ServiceStatus {
  label: string;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

export function status(label: string): ServiceStatus {
  try {
    const result = execFileSync("launchctl", ["print", gui(label)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pidMatch = result.match(/\bpid\s*=\s*(\d+)/);
    const exitMatch = result.match(/last exit code\s*=\s*(-?\d+)/);
    return {
      label,
      loaded: true,
      pid: pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : null,
      lastExitStatus: exitMatch?.[1] ? Number.parseInt(exitMatch[1], 10) : null,
    };
  } catch {
    return { label, loaded: false, pid: null, lastExitStatus: null };
  }
}

function runLaunchctl(args: string[]): { stdout: string; stderr: string } {
  const result = execFileSync("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout: result, stderr: "" };
}

export function getHostname(): string {
  return hostname();
}

export function ensureLogDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
