import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

/**
 * Locate the `claude` binary. PATH-first; falls back to a handful of
 * standard install locations because launchd-spawned daemons often have
 * a minimal PATH that doesn't include `~/.local/bin`, which is where the
 * Claude Code installer puts the binary by default.
 *
 * Memoized — resolved once per worker process.
 */
let cachedClaudePath: string | null = null;
function resolveClaudeBinary(): string {
  if (cachedClaudePath) return cachedClaudePath;
  // Honour an explicit override first.
  const override = process.env.WAZIR_CLAUDE_BIN;
  if (override && existsSync(override)) { cachedClaudePath = override; return override; }
  // Try common locations in order. Each is the place Claude Code's
  // installer / brew / volta / nvm typically drops the symlink.
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) { cachedClaudePath = c; return c; }
  }
  // Fall back to letting the shell resolve via PATH — caller will see
  // a clean ENOENT if it's really missing.
  cachedClaudePath = "claude";
  return "claude";
}

/**
 * Drives one non-interactive Claude Code turn via `claude --print`.
 *
 * This replaces the tmux send-keys + JSONL-polling approach used by the
 * Telegram flow. Each user message is one short-lived process; the
 * response is captured directly from the stream-json stdout and the
 * process exit is the unambiguous "done" signal.
 *
 * Why this is better than the tmux path:
 *   - One process per message ⇒ no race over a shared pane.
 *   - Streamed output ⇒ we know the exact response text without
 *     scraping a TUI.
 *   - Exit code ⇒ no "is Claude still working?" detection.
 *   - The JSONL on disk still gets appended (this is exactly how
 *     `claude` persists sessions), so /resume from a terminal still
 *     sees the conversation.
 */

export interface PrintTurnOptions {
  sessionId: string;
  prompt: string;
  cwd: string;
  /** If set, called with each text fragment as it arrives. */
  onText?: (delta: string) => void;
  /** If set, called when a tool starts running. */
  onToolUse?: (event: ToolUseEvent) => void;
  /** Hard timeout (ms). Default 600 000 (10 min). */
  timeoutMs?: number;
}

export interface ToolUseEvent {
  /** Tool name (e.g. "Bash", "Read", "Edit"). */
  name: string;
  /** Best-effort string preview of the tool input. */
  preview: string;
}

export interface PrintTurnResult {
  /** Final assistant text (concatenated from all text content blocks). */
  text: string;
  /** Tools called during the turn, in order. */
  tools: ToolUseEvent[];
  /** Total wall time (ms). */
  durationMs: number;
  /** Final stop reason as reported by Claude Code (e.g. "end_turn"). */
  stopReason: string | null;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Run one Claude Code turn against `sessionId` with `prompt`.
 *
 * Resolves when the `result` event is seen or the child exits. Rejects on
 * spawn failure, timeout, or a non-zero exit with no result.
 */
export async function runPrintTurn(opts: PrintTurnOptions): Promise<PrintTurnResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const sessionExists = sessionJsonlExists(opts.sessionId, opts.cwd);

  const args: string[] = [
    "--print",
    sessionExists ? "--resume" : "--session-id",
    opts.sessionId,
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    opts.prompt,
  ];

  const claudeBin = resolveClaudeBinary();
  const child = spawn(claudeBin, args, {
    cwd: opts.cwd,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<PrintTurnResult>((resolve, reject) => {
    const collectedText: string[] = [];
    const collectedTools: ToolUseEvent[] = [];
    let finalResult: string | null = null;
    let stopReason: string | null = null;
    let stderrBuf = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      settle(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        reject(new Error(`claude --print timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timeout.unref?.();

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let evt: PrintEvent;
      try {
        evt = JSON.parse(line) as PrintEvent;
      } catch {
        return;
      }
      handleEvent(evt, collectedText, collectedTools, opts);
      if (evt.type === "result") {
        const r = (evt as ResultEvent).result;
        if (typeof r === "string") finalResult = r;
      }
      if (evt.type === "stream_event" && (evt as StreamEvent).event?.type === "message_delta") {
        const sr = (evt as StreamEvent).event?.delta?.stop_reason;
        if (typeof sr === "string") stopReason = sr;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      settle(() => {
        clearTimeout(timeout);
        reject(new Error(`failed to spawn claude: ${err.message}`));
      });
    });

    child.on("exit", (code, signal) => {
      settle(() => {
        clearTimeout(timeout);
        const text = (finalResult ?? collectedText.join("")).trim();
        if (code === 0 || (code === null && signal === null)) {
          resolve({
            text,
            tools: collectedTools,
            durationMs: Date.now() - start,
            stopReason,
          });
          return;
        }
        if (text) {
          resolve({ text, tools: collectedTools, durationMs: Date.now() - start, stopReason });
          return;
        }
        reject(new Error(
          `claude --print exited with code=${code} signal=${signal}; stderr: ${stderrBuf.slice(0, 500)}`,
        ));
      });
    });
  });
}

function handleEvent(
  evt: PrintEvent,
  collectedText: string[],
  collectedTools: ToolUseEvent[],
  opts: PrintTurnOptions,
): void {
  if (evt.type !== "stream_event") return;
  const inner = (evt as StreamEvent).event;
  if (!inner) return;
  if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
    collectedText.push(inner.delta.text);
    opts.onText?.(inner.delta.text);
    return;
  }
  if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
    const name = String(inner.content_block.name ?? "tool");
    const preview = previewToolInput(inner.content_block);
    const event = { name, preview };
    collectedTools.push(event);
    opts.onToolUse?.(event);
  }
}

function previewToolInput(block: ContentBlock): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === "string") return obj.command;
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.path === "string") return obj.path;
  if (typeof obj.url === "string") return obj.url;
  if (typeof obj.query === "string") return obj.query;
  try { return JSON.stringify(input).slice(0, 160); }
  catch { return ""; }
}

/**
 * Check whether the on-disk JSONL for a given session already exists.
 * Claude Code stores transcripts under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
 *
 * If it exists we use `--resume`; otherwise we use `--session-id` to
 * create it.
 */
function sessionJsonlExists(sessionId: string, cwd: string): boolean {
  const encoded = encodeCwd(cwd);
  return existsSync(join(CLAUDE_PROJECTS_DIR, encoded, `${sessionId}.jsonl`));
}

function encodeCwd(cwd: string): string {
  // Claude Code uses `-` as the path-separator replacement and prefixes with `-`.
  return "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
}

// ---------------------------------------------------------------
// Event shape declarations — narrow subset of the stream-json spec.
// ---------------------------------------------------------------

interface PrintEvent {
  type: string;
}

interface StreamEvent extends PrintEvent {
  type: "stream_event";
  event?: {
    type: string;
    index?: number;
    delta?: { type?: string; text?: string; stop_reason?: string };
    content_block?: ContentBlock;
  };
}

interface ResultEvent extends PrintEvent {
  type: "result";
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
}

interface ContentBlock {
  type?: string;
  name?: string;
  input?: unknown;
}
