import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { DiscoveredSession } from "@wazir/protocol";

const CLAUDE_PROJECTS_DIR = resolve(homedir(), ".claude", "projects");
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Enumerate all Claude Code sessions persisted on this machine.
 *
 * For each `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` file we parse:
 * - cwd  → read from inside the JSONL (any message line carries it),
 *          since the encoded-cwd directory name loses information when
 *          original path segments contain dashes
 * - first user message  → used as the human label for the session
 * - last assistant message  → used in /resume summaries
 * - model id (latest)  → optional
 * - message count  → only counting user + assistant rows
 * - mtime  → used as last_activity_at
 */
export function discoverClaudeSessions(): DiscoveredSession[] {
  let dirs: string[];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: DiscoveredSession[] = [];
  for (const dirName of dirs) {
    const dirPath = join(CLAUDE_PROJECTS_DIR, dirName);
    let files: string[];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sessionId = f.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const fullPath = join(dirPath, f);
      let mtimeMs: number;
      let size: number;
      try {
        const st = statSync(fullPath);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue;
      }
      if (size === 0) continue;
      const meta = parseSessionMeta(fullPath);
      if (!meta || !meta.cwd) continue;
      const discovered: DiscoveredSession = {
        session_id: sessionId,
        agent: "claude",
        cwd: meta.cwd,
        message_count: meta.messageCount,
        last_activity_at: Math.round(mtimeMs),
      };
      if (meta.firstUserMessage !== undefined) discovered.first_message = meta.firstUserMessage;
      if (meta.lastAssistantMessage !== undefined) discovered.last_assistant = meta.lastAssistantMessage;
      if (meta.model !== undefined) discovered.model = meta.model;
      if (meta.customTitle !== undefined) discovered.agent_title = meta.customTitle;
      if (meta.aiTitle !== undefined) discovered.ai_title = meta.aiTitle;
      out.push(discovered);
    }
  }
  out.sort((a, b) => b.last_activity_at - a.last_activity_at);
  return out;
}

/** Find one specific session by id without enumerating the whole tree. */
export function findClaudeSession(sessionId: string): DiscoveredSession | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dirName of dirs) {
    const fullPath = join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
    let mtimeMs: number;
    try {
      const st = statSync(fullPath);
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    const meta = parseSessionMeta(fullPath);
    if (!meta || !meta.cwd) return null;
    const discovered: DiscoveredSession = {
      session_id: sessionId,
      agent: "claude",
      cwd: meta.cwd,
      message_count: meta.messageCount,
      last_activity_at: Math.round(mtimeMs),
    };
    if (meta.firstUserMessage !== undefined) discovered.first_message = meta.firstUserMessage;
    if (meta.lastAssistantMessage !== undefined) discovered.last_assistant = meta.lastAssistantMessage;
    if (meta.model !== undefined) discovered.model = meta.model;
    if (meta.customTitle !== undefined) discovered.agent_title = meta.customTitle;
    if (meta.aiTitle !== undefined) discovered.ai_title = meta.aiTitle;
    return discovered;
  }
  return null;
}

interface SessionMeta {
  cwd?: string;
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  messageCount: number;
  model?: string;
  customTitle?: string;
  aiTitle?: string;
}

function parseSessionMeta(path: string): SessionMeta | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const meta: SessionMeta = { messageCount: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const o = obj as Record<string, unknown>;
    if (!meta.cwd && typeof o.cwd === "string") meta.cwd = o.cwd;
    // Claude Code emits dedicated records for session titles. The last
    // occurrence wins (so user changes via /rename override prior values).
    if (o.type === "custom-title" && typeof o.customTitle === "string") {
      meta.customTitle = o.customTitle;
    } else if (o.type === "ai-title" && typeof o.aiTitle === "string") {
      meta.aiTitle = o.aiTitle;
    }
    if (o.type === "user" || o.type === "assistant") {
      meta.messageCount += 1;
      const content = extractText(o);
      if (o.type === "user") {
        // First "real" user message we can show as a session label. We skip
        // tool-result rows and Claude Code's synthetic slash-command wrappers
        // (`<local-command-caveat>`, `<command-message>`, etc.) which would
        // otherwise drown out the actual prompt.
        if (
          !meta.firstUserMessage &&
          content &&
          !looksLikeToolResult(o) &&
          !isLocalCommandPreamble(content)
        ) {
          meta.firstUserMessage = content;
        }
      } else {
        // assistant — keep updating; last write wins
        if (content) meta.lastAssistantMessage = content;
        const inner = (o.message as Record<string, unknown> | undefined)?.model;
        if (typeof inner === "string") meta.model = inner;
      }
    }
  }
  return meta;
}

/**
 * Claude Code wraps slash-command output in synthetic `<local-command-caveat>`
 * / `<command-message>` user messages. Those aren't useful as session labels.
 */
function isLocalCommandPreamble(text: string): boolean {
  const head = text.trimStart().slice(0, 64);
  return /^<(?:local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args))/.test(head);
}

function extractText(row: Record<string, unknown>): string | undefined {
  const msg = row.message as Record<string, unknown> | undefined;
  if (!msg) return undefined;
  if (typeof msg.content === "string") {
    const s = msg.content.trim();
    return s || undefined;
  }
  if (Array.isArray(msg.content)) {
    const parts: string[] = [];
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined || undefined;
  }
  return undefined;
}

/** Heuristic: tool-result messages have content arrays containing tool_use_id blocks. */
function looksLikeToolResult(row: Record<string, unknown>): boolean {
  const msg = row.message as Record<string, unknown> | undefined;
  if (!msg || !Array.isArray(msg.content)) return false;
  for (const block of msg.content as Array<Record<string, unknown>>) {
    if (block && (block.type === "tool_result" || "tool_use_id" in block)) return true;
  }
  return false;
}
